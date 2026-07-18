# OneShot Statistics — Integration Test Runbook

`oneshotStatistics.integration.test.ts` exercises the snapshot persistence,
lease, fingerprint-stale, and back-compat-merge paths of `getOneShotStatistics`
against a real MySQL connection. The default `npm test` suite **skips this file**
(`describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)`) so CI without a MySQL
service stays green.

This is a **pre-merge gate**, not a per-PR gate. Run it before requesting human
review on the `codex/ai-statistics-tab` branch (or any future branch that
modifies `oneshotStatistics.ts`).

## What it covers

1. **Cold start** — empty refresh state and snapshots; `getOneShotStatistics`
   returns `'generating'` (or `'deterministic_only'` if it can't claim the
   lease), writes the refresh-state row, and surfaces a fresh
   `failureAttribution` with `attributionVersion: 2`.
2. **Lease bounds the thundering herd** — 5 parallel callers produce ≤2
   snapshot rows (collapses to 1 in prod with a pre-populated lease row).
3. **Back-compat merge** — manually inserts a `ready` snapshot whose
   `snapshot_json` predates the `failureAttribution` field; the response still
   carries a fresh `failureAttribution` and does not throw.
4. **LLM failure persists status='failed' with `error_message`** — Bedrock
   rejection writes a `failed`-status snapshot row with the error message
   captured for on-call diagnosis.

## Setup

```bash
# Bring up the local-oneshot MySQL service (port 3307).
docker compose -f local-oneshot/docker-compose.yml up -d mysql
```

The migrations are applied automatically by the test's `beforeAll`. You don't
need to run `mysql -e ... < db/migrations/025_*.sql` manually — the test
re-creates the two relevant tables idempotently.

## Run

```bash
RUN_INTEGRATION_TESTS=1 \
  DB_HOST=127.0.0.1 DB_PORT=3307 DB_USER=root \
  DB_PASSWORD=specter_local DB_NAME=Specter \
  npm --prefix dashboard test -- oneshotStatistics.integration
```

Expected: `4 passed (4)`. Total runtime ≈1s.

## Tear down

The test suite uses `pool.end()` in `afterAll` so vitest exits cleanly. The
MySQL container can be stopped via:

```bash
docker compose -f local-oneshot/docker-compose.yml stop mysql
```

State persists between runs in the `mysql_data` volume, but each test cleans
its tables in `afterEach`, so re-running the suite is safe.

## Why this gate exists

Unit tests for `oneshotStatistics.ts` mock `getPool()` entirely. That gives
fast feedback on the deterministic-builder logic, but it leaves four real-DB
behaviors completely uncovered:

- **`mysql2` connection-pool race conditions** during parallel calls.
- **`JSON` column round-tripping** — old snapshot shapes vs. new shapes.
- **Conditional-UPDATE row-locking** semantics in MySQL 8.4 (lease behavior).
- **Foreign-key constraint** between `oneshot_statistics_refresh_state.latest_snapshot_id`
  and `oneshot_statistics_snapshots.id`.

The first prod deploy of any branch touching this code path SHOULD have run
this suite locally first. Failing to do so risks discovering a snapshot-write
or lease bug under prod load instead of in 1s of test time.
