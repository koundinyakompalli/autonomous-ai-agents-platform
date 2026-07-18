MERIDIAN Backend Package
========================

This directory packages the Meridian Python backend used by the MERIDIAN worker.

Runtime model:

- `MERIDIANWorker` fetches Jira, resolves the approved target, opens an operator LDAP SSH tunnel to the database, and posts generated SQL back to Jira.
- The packaged FastAPI backend runs locally in the worker container and performs deterministic parsing, DB-backed value resolution, PHI-safe current-value checks, and SQL generation.
- The backend is auto-started only when `MERIDIAN_API_BASE_URL` is not configured. Set `MERIDIAN_API_BASE_URL` to use an externally managed Meridian backend instead.

Important environment variables:

- `MERIDIAN_BACKEND_AUTOSTART`: defaults to `true` when `MERIDIAN_API_BASE_URL` is unset.
- `MERIDIAN_BACKEND_DIR`: defaults to `meridian/backend`.
- `MERIDIAN_PYTHON_BIN`: defaults to `python3`.
- `MERIDIAN_PROFILES_DIR`: set by the worker to a per-task temp directory so DB credentials are not written to the default home profile store.
- `MERIDIAN_TARGETS_JSON` or `MERIDIAN_TARGETS_FILE`: target definitions. Meridian DB access requires `networkPath: "ssh_public"`, `sshAllowed: true`, `ssmAllowed: false`, an approved SSH host (`publicHost`, `sshHost`, `loginHost`, or `bastionHost`), and `remoteHost` for the MySQL endpoint.
- `MERIDIAN_SSH_USER`: LDAP username for the SSH hop. Falls back to `INVESTIGATION_SSH_USER`, target `sshUser`, then `USER`.
- `MERIDIAN_SSH_CONTROL_PATH`: optional SSH control socket path. Falls back to `INVESTIGATION_SSH_CONTROL_PATH`.
- `MERIDIAN_SSH_PORT`: optional SSH port override. Falls back to `INVESTIGATION_SSH_PORT`, target `sshPort`, then `22`.
- `MERIDIAN_DB_USERNAME`, `MERIDIAN_DB_PASSWORD`, `MERIDIAN_DB_DATABASE`: optional Meridian-specific DB credentials.
- Cockpit DB env can be reused when Meridian-specific DB env is not set: `INVESTIGATION_DB_USERNAME`, `INVESTIGATION_DB_PASSWORD`, and `INVESTIGATION_DB_DATABASE`.
- Cockpit-style target refs are also supported: `dbUser: "env://INVESTIGATION_DB_USERNAME"` and `secretRef: "env://INVESTIGATION_DB_PASSWORD"`.
- If a Cockpit run uses only `INVESTIGATION_OPERATOR_SSH_USER` / `INVESTIGATION_OPERATOR_SSH_PASSWORD`, either export the MERIDIAN/DB env vars from those values before starting the MERIDIAN worker or point the target `dbUser` / `secretRef` directly at those `env://INVESTIGATION_OPERATOR_SSH_*` variables.

The backend generates SQL for DBA/operator review. It does not execute generated DML.
