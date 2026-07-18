# Harden MERIDIAN packaged backend controls

## Status

Implemented in PR #193 for MERIDIAN + Investigation Cockpit pre-pilot
governance hardening.

The POC demonstrates Jira ingestion, SSM/local tunnel connectivity,
deterministic SQL generation, Cockpit orchestration, runtime evidence
gathering, and human-reviewed output. This hardening work closes
packaged-backend control gaps that should not be treated as optional for
governed deployment.

Implemented controls:

- implemented backend bearer-token enforcement for packaged mode
- disabled raw query and stored profile surfaces in packaged mode
- added runtime-only DB activation/deactivation for the packaged worker
- added DB grant verification before validation/generation
- added redacted Jira SQL preview attachment behavior by default
- added approved target registry validation with optional environment allowlists

## Problem

The packaged MERIDIAN worker starts a local FastAPI backend that was copied from
the BECU-style development tool. In local developer mode that backend supports
convenience operations such as connection profiles and raw SELECT queries.

In packaged worker mode, those convenience surfaces create governance risk:

- unauthenticated loopback endpoints can bypass worker-level audit/redaction
- raw SELECT capability can become unrestricted PHI browsing even with a
  read-only database user
- connection profile storage persists DB credentials in an app-local profile
  store
- DB read-only status is assumed from the secret name or intended account, not
  verified at runtime
- generated SQL can include new PHI/PII values if a ticket requests a
  member-name, address, phone, email, or similar data correction
- target files/env can choose SSM instances, remote hosts, role ARNs, and
  database destinations without a reviewed registry boundary

## Goals

- Harden MERIDIAN packaged backend controls.
- Preserve local developer usability where explicitly enabled.
- Make packaged worker mode fail closed.
- Keep SQL generation review-only and outside autonomous execution.
- Ensure governance documentation matches enforced behavior.

## Required controls

### 1. Backend authentication

Packaged backend mode must require a worker-generated bearer token on every
operational endpoint. Health can remain unauthenticated only for local liveness
checks and must not expose secrets or raw DB data.

Acceptance criteria:

- `MERIDIAN_PACKAGED_BACKEND=true` requires `MERIDIAN_BACKEND_TOKEN`
- worker sends `Authorization: Bearer <token>` to backend requests
- unauthenticated calls to generation, lookup, parse, connection, or query
  endpoints return `401`
- token is never logged

### 2. Disable raw query and stored profiles in packaged mode

The packaged backend must not expose general-purpose profile management or raw
query execution.

Acceptance criteria:

- `/api/query` is disabled in packaged mode
- stored profile create/test/activate/delete endpoints are disabled in packaged
  mode
- packaged worker uses an in-memory runtime connection activation endpoint
  that does not write DB passwords to disk
- runtime connection is deactivated at the end of each MERIDIAN task

### 3. Read-only grant verification

The backend must verify the active DB principal before validation/generation.
The dedicated DataTrace/MERIDIAN database user remains the primary DB-side
control, but MERIDIAN must verify that it is actually read-only.

Acceptance criteria:

- run `SHOW GRANTS FOR CURRENT_USER()` or equivalent for the configured engine
- fail closed if write/admin grants are present, including `INSERT`, `UPDATE`,
  `DELETE`, `CREATE`, `ALTER`, `DROP`, `TRUNCATE`, `GRANT`, `SUPER`, `FILE`,
  or `ALL PRIVILEGES`
- record a redacted audit event showing target id, read-only verification
  status, and timestamp
- no validation queries run until verification passes

### 4. Approved target registry

SSM port-forward targets must come from a reviewed target registry, not an
untrusted arbitrary env/file payload.

Acceptance criteria:

- target entries include approved client, environment, instance id, role ARN,
  remote host, remote port, database name, and access class
- worker rejects targets outside configured allowlists
- role ARN and instance id are compared to approved values
- target registry changes require code/config review or signed artifact
  approval
- no broad "any host/any role" mode in packaged production worker mode

### 5. PHI-safe SQL/Jira output

MERIDIAN can generate review-only SQL files for DBA review, but Jira comments
and logs must not expose PHI/PII values.

Acceptance criteria:

- SQL attached/postable output is passed through a PHI redaction layer before
  it is embedded in Jira comments
- configured PHI columns from `phi_columns.yaml` are used to block or redact
  new-value literals, not just current DB values
- Jira comments contain summaries and a redacted SQL package or attachment
  reference, not raw unredacted member data
- raw unredacted SQL, if needed for DBA execution, is stored only in an
  approved secure artifact path with access controls and audit

### 6. Query-pack boundary for validation

Read-only does not mean unrestricted. Validation queries should be generated by
MERIDIAN deterministic flows or approved query packs only.

Acceptance criteria:

- no arbitrary SELECT endpoint in packaged mode
- validation queries use deterministic modules, configured lookup SQL, or
  approved query packs
- row limits and query timeouts are enforced
- table/column PHI policy is applied before results are returned or logged

## Non-goals

- No autonomous SQL execution.
- No broad shell execution inside the DB or application host.
- No production primary database access.
- No replacement for DBA/change-control review.

## Implementation sequence

1. Add backend bearer-token auth and worker token injection.
2. Disable raw query and stored profile endpoints in packaged mode.
3. Add runtime-only connection activation/deactivation.
4. Verify read-only grants during activation.
5. Add PHI-safe SQL/Jira redaction using `phi_columns.yaml`.
6. Add target-registry allowlist validation for SSM destinations and role ARNs.
7. Add backend/worker regression tests.
8. Update governance docs after tests pass.

## Governance position

For Prototype/POC review, these controls can be listed as required hardening
before pilot or production use. For pilot/production approval, these controls
should be implemented, tested, and evidenced.
