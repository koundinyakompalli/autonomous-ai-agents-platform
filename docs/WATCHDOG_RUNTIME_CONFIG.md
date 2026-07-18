# Watchdog Runtime Configuration

Watchdog runs inside the Specter dashboard API and uses the Watchdog MCP server for CloudWatch/Jira reads. The browser never talks directly to MCP, AWS, Bedrock, or S3.

## Required Runtime Settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `WATCHDOG_INVESTIGATOR` | `fake_no_evidence` | Use `llm_log_analysis` for live MCP + Claude analysis. |
| `WATCHDOG_LLM_MODEL_ID` | `us.anthropic.claude-sonnet-4-6` | Claude model used by the Claude Agent SDK through Bedrock. |
| `WATCHDOG_BEDROCK_REGION` | `us-east-2` | Region for Bedrock model invocation. |
| `WATCHDOG_EVIDENCE_BUCKET` | `${S3_BUCKET_PREFIX}-watchdog-evidence` | Dedicated bucket for redacted Watchdog evidence payload JSON. |
| `WATCHDOG_EVIDENCE_REGION` | `AWS_REGION`/`us-east-2` | Region for the dedicated evidence bucket. |

## Runtime Controls

| Variable | Default | Purpose |
| --- | --- | --- |
| `WATCHDOG_LLM_MAX_OUTPUT_TOKENS` | `1800` | Output cap for final analysis. |
| `WATCHDOG_CLAUDE_MAX_TURNS` | `1` | Claude Agent SDK turn cap. |
| `WATCHDOG_CLAUDE_MAX_BUDGET_USD` | `1` | Claude Agent SDK budget cap per invocation. |
| `WATCHDOG_CLAUDE_TIMEOUT_MS` | `120000` | Wall timeout for final analysis. |
| `WATCHDOG_CLAUDE_PLAN_TIMEOUT_MS` | `60000` | Wall timeout for follow-up MCP planning. |
| `WATCHDOG_AGENTIC_MCP_LOOP` | `enabled` | Set to `disabled` to skip LLM-planned follow-up searches. |
| `WATCHDOG_MAX_ACTIVE_RUNS_PER_OPERATOR` | `3` | Per-operator active session cap for queued/running/awaiting runs. |
| `WATCHDOG_REAPER_INTERVAL_SECONDS` | `60` | Background stale-run and clarification-expiry interval. |
| `WATCHDOG_CLEANUP_INTERVAL_SECONDS` | `900` | Background expired SSE/audit cleanup interval. |
| `WATCHDOG_CLARIFICATION_TTL_HOURS` | `48` | How long an open clarification can wait for operator input. |
| `WATCHDOG_MCP_HTTP_URL` | unset | Optional local/shared-container MCP endpoint such as `http://host.containers.internal:8000/mcp`; stdio remains the production default. |
| `WATCHDOG_MCP_AUTH_MODE` | unset | Optional display fallback for dashboard health when MCP healthcheck is unavailable. MCP healthcheck is authoritative when reachable. |
| `WATCHDOG_ALLOW_LOCAL_OPERATOR_FALLBACK` | `false` | Local container-only auth bypass for browser smoke tests without ALB identity headers. Keep false in real production. |

## MCP AWS Auth Modes

Watchdog separates Specter app credentials from MCP CloudWatch credentials:

- Specter dashboard API uses the dev/prod ECS task role or local dev credentials for Bedrock, Jira secret reads, S3 evidence writes, and DARCI task handoff.
- Watchdog MCP uses its own AWS credential source only for read-only prod CloudWatch/ECS investigation tools.

For local and sandbox/dev deployments, use the shared MCP HTTP endpoint backed by Secrets Manager:

```bash
WATCHDOG_MCP_HTTP_URL=http://host.containers.internal:8000/mcp
WATCHDOG_MCP_AUTH_MODE=sandbox_static_secret
```

The MCP container itself needs:

```bash
WATCHDOG_AWS_AUTH_MODE=sandbox_static_secret
WATCHDOG_PROD_READER_SECRET_ARN=arn:aws:secretsmanager:us-east-2:<dev-account-id>:secret:/specter/dev/watchdog/prod-reader-...
WATCHDOG_SECRETS_REGION=us-east-2
WATCHDOG_AWS_ACCOUNT_ID=239350186085
```

The prod-reader secret must be JSON:

```json
{
  "aws_account_id": "239350186085",
  "aws_access_key_id": "AKIA...",
  "aws_secret_access_key": "..."
}
```

`aws_session_token` is supported for temporary smoke tests, but production-like dev runs should use a real read-only prod-reader IAM access key. The dashboard health endpoint reports the MCP auth mode from MCP `healthcheck` as `mode`; this should show `sandbox_static_secret` when the secret-backed path is active.

## Terraform Deployment Shape

In sandbox/dev, Terraform deploys Watchdog as part of the existing dashboard ECS task:

- `dashboard` container serves the Watchdog UI/API on port `3001`.
- `watchdog-mcp` sidecar serves Streamable HTTP on `127.0.0.1:8000/mcp` inside the task.
- `specter/watchdog-mcp` ECR stores the MCP sidecar image.
- `specter-watchdog-evidence` stores redacted Watchdog evidence payloads under `watchdog/evidence/...`.
- The shared Specter task role reads the prod-reader Secrets Manager secret and writes/reads the Watchdog evidence bucket.

Load-bearing Terraform variables:

```hcl
enable_watchdog                  = true
watchdog_mcp_image_tag           = "latest"
watchdog_prod_reader_secret_name = "/specter/dev/watchdog/prod-reader"
watchdog_prod_account_id         = "239350186085"
watchdog_evidence_bucket         = "specter-watchdog-evidence"
watchdog_investigator            = "llm_log_analysis"
watchdog_agentic_mcp_loop        = "disabled"
```

The dashboard task memory should be at least `2048` MB when the MCP sidecar is enabled.

## Dedicated Evidence Bucket

Watchdog evidence payloads must use a separate S3 bucket from DARCI task payloads. The default bucket name is `${S3_BUCKET_PREFIX}-watchdog-evidence`, for example `specter-watchdog-evidence`.

The ECS task role needs:

```json
{
  "Effect": "Allow",
  "Action": ["s3:PutObject", "s3:GetObject"],
  "Resource": "arn:aws:s3:::specter-watchdog-evidence/watchdog/evidence/*"
}
```

If the bucket uses a customer-managed KMS key, also grant `kms:Encrypt`, `kms:Decrypt`, and `kms:GenerateDataKey` for that key to the Specter dashboard task role.

## Clarification Flow

When MCP cannot resolve the investigation scope, the runner writes an open clarification, transitions the session to `awaiting_user_input`, and emits `clarification.required`.

The Watchdog UI renders the open clarification in the Draft Scope column. When the operator answers, the API marks the clarification answered and creates a new `clarification_resume` run attempt with the answer embedded in the approved scope under `advancedFilters.clarification`.

## Local Smoke Checklist

1. Set `WATCHDOG_INVESTIGATOR=llm_log_analysis`.
2. Set `WATCHDOG_EVIDENCE_BUCKET` to a real dedicated bucket in the dev account.
3. Start the dashboard API with credentials that can call Bedrock and write/read the evidence bucket.
4. Run a Watchdog investigation and confirm the Evidence tab shows `View payload`.
5. Force or simulate an MCP `needs_user_input` response and confirm the Clarification card appears and queues a resumed run after answer submission.
