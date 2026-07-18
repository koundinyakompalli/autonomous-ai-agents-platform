# OneShot Phase 1 Design: Schema and State Services

> **Historical design note**
> This document is a 2026-04-12 design snapshot. The live OneShot runtime has changed since this spec was written.
> Use [ONESHOT_RUNBOOK.md](../../ONESHOT_RUNBOOK.md), [ONESHOT_PREVIEW_RUNBOOK.md](../../ONESHOT_PREVIEW_RUNBOOK.md), [DEPLOYMENT_GUIDE.md](../../DEPLOYMENT_GUIDE.md), and [terraform/README.md](../../../terraform/README.md) as the current operational source of truth.

**Date**: 2026-04-12
**Status**: Revised after review
**Parent plan**: `plans/09-one-shotting-feature-delivery-pipeline.md`
**Phase**: 1 of 7

## Summary

Phase 1 delivers the database schema, TypeScript types, and DB access layer for the OneShot pipeline. No agents, consumers, or SQS integration — just the durable foundation that Phases 2-6 build on.

## Decisions made during design

- **DB layer location**: Standalone `OneShotDatabase` class in `src/oneshot/database/` that accepts the existing `mysql2` pool via constructor injection. Shares the connection pool with the existing `Database` singleton. Avoids bloating the existing `database.ts` (736 lines) and keeps OneShot isolated.
- **State transition enforcement**: Atomic claim pattern at concurrency boundaries only (matching existing Specter pattern). Single-consumer flows use simple updates. The state machine is documented in the plan; the DB layer does not re-enforce every edge.
- **File structure**: Approach B (layered) — one migration, types in a shared file, DB access split by table into focused modules behind a facade.

## Deliverables

```
db/migrations/005_oneshot_schema.sql
src/oneshot/types.ts
src/oneshot/database/index.ts
src/oneshot/database/runs.ts
src/oneshot/database/artifacts.ts
src/oneshot/database/notifications.ts
```

---

## 1. Migration: `db/migrations/005_oneshot_schema.sql`

All three tables in one migration file, following existing convention (numbered SQL files in `db/migrations/`).

### `oneshot_runs`

Central state machine. One row per PFOS ticket run.

```sql
CREATE TABLE IF NOT EXISTS oneshot_runs (
  id                             BIGINT AUTO_INCREMENT PRIMARY KEY,
  jira_key                       VARCHAR(50)  NOT NULL,
  source_task_management_id      INT          NOT NULL,
  customer_id                    INT          NOT NULL,
  repo_id                        INT          NOT NULL,
  branch_name                    VARCHAR(255) NOT NULL,
  base_commit_sha                VARCHAR(40)  NOT NULL,
  state                          VARCHAR(50)  NOT NULL DEFAULT 'queued_for_planning',
  active_jira_key                VARCHAR(50)
    GENERATED ALWAYS AS (
      CASE
        WHEN state IN ('completed', 'blocked', 'failed') THEN NULL
        ELSE jira_key
      END
    ) STORED,
  max_review_loops               INT          NOT NULL DEFAULT 3,
  review_loop_count              INT          NOT NULL DEFAULT 0,
  current_plan_version           INT          NULL,
  current_review_version         INT          NULL,
  current_implementation_version INT          NULL,
  current_pr_url                 VARCHAR(1024) NULL,
  final_disposition              VARCHAR(50)  NULL,
  last_error                     TEXT         NULL,
  max_total_tokens               INT          NOT NULL DEFAULT 2000000,
  total_tokens_used              INT          NOT NULL DEFAULT 0,
  created_at                     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uk_active_jira (active_jira_key),
  FOREIGN KEY (source_task_management_id) REFERENCES task_management(id),
  FOREIGN KEY (customer_id)               REFERENCES customer_branches(id),
  FOREIGN KEY (repo_id)                   REFERENCES code_repositories(id),

  INDEX idx_state (state),
  INDEX idx_jira_key (jira_key),
  INDEX idx_state_updated (state, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

Design notes:
- `state` is `VARCHAR(50)` not `ENUM` — avoids migration on every state addition. Validation lives in TypeScript.
- `active_jira_key` is the MySQL workaround for "one active run per Jira ticket" without blocking historical reruns.
- terminal states for the generated key are `completed`, `blocked`, and `failed`.
- `escalated`, `replan_required`, and `pr_open` remain active by design, so the same Jira ticket cannot spawn a second run until the first is resolved.
- if the set of terminal states changes later, the generated-column expression must be updated in a follow-up migration.
- `max_total_tokens` / `total_tokens_used` implement the per-run cost ceiling (default 2M tokens).
- Foreign keys to `task_management`, `customer_branches`, `code_repositories` maintain referential integrity with existing tables.

### `oneshot_artifacts`

One row per stage execution artifact. Supports upsert on retry.

```sql
CREATE TABLE IF NOT EXISTS oneshot_artifacts (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  oneshot_run_id BIGINT       NOT NULL,
  stage          ENUM('qualification', 'plan', 'review', 'implementation') NOT NULL,
  version        INT          NOT NULL,
  status         VARCHAR(50)  NOT NULL,
  s3_bucket      VARCHAR(255) NOT NULL,
  s3_key         VARCHAR(1024) NOT NULL,
  provider       VARCHAR(50)  NULL,
  model          VARCHAR(100) NULL,
  metadata_json  JSON         NULL,
  started_at     TIMESTAMP    NULL,
  completed_at   TIMESTAMP    NULL,
  created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,

  UNIQUE KEY uk_run_stage_version (oneshot_run_id, stage, version),
  FOREIGN KEY (oneshot_run_id) REFERENCES oneshot_runs(id),

  INDEX idx_run_id (oneshot_run_id),
  INDEX idx_stage (stage)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

Design notes:
- `stage` is `ENUM` because the set of stages is fixed by architecture (unlike states which may evolve).
- Unique constraint on `(oneshot_run_id, stage, version)` enables upsert via `INSERT ... ON DUPLICATE KEY UPDATE`.
- `metadata_json` holds stage-specific fields: plan summaries, review decisions, PR URLs, etc. Validated by consumers, not the DB layer.
- `qualification` artifacts are only written for successful qualification after the run row exists. Qualification failures stay on the legacy `task_management` comment path and do not create OneShot rows.
- `started_at` / `completed_at` track stage execution duration.

### `oneshot_notifications`

DB-owned notification queue for Jira posting.

```sql
CREATE TABLE IF NOT EXISTS oneshot_notifications (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  oneshot_run_id BIGINT       NOT NULL,
  jira_key       VARCHAR(50)  NOT NULL,
  notification_type VARCHAR(50) NOT NULL,
  body_markdown  TEXT         NOT NULL,
  status         ENUM('pending', 'posting', 'posted', 'failed') NOT NULL DEFAULT 'pending',
  error          TEXT         NULL,
  created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  posted_at      TIMESTAMP    NULL,

  FOREIGN KEY (oneshot_run_id) REFERENCES oneshot_runs(id),

  INDEX idx_status (status),
  INDEX idx_run_id (oneshot_run_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

Design notes:
- `status` is `ENUM` because the notification lifecycle is simple and stable (4 values).
- `notification_type` is `VARCHAR(50)` to allow new types without migration.
- notifications only exist after a run row exists. Qualification failures stay on the legacy `task_management` path and do not enter `oneshot_notifications`.
- Atomic claim pattern: `pending` -> `posting` -> `posted` or back to `pending` on failure.

### Reconciliation view

```sql
CREATE OR REPLACE VIEW v_oneshot_stuck_runs AS
SELECT id, jira_key, state, updated_at
FROM oneshot_runs
WHERE state LIKE 'queued_for_%'
  AND updated_at < NOW() - INTERVAL 10 MINUTE;
```

Used by the reconciliation mechanism (Phase 6) to find runs where the SQS publish likely failed.

---

## 2. TypeScript Types: `src/oneshot/types.ts`

### State and stage types

```typescript
export type OneShotState =
  | 'queued_for_planning'
  | 'planning'
  | 'queued_for_review'
  | 'reviewing'
  | 'needs_revision'
  | 'approved'
  | 'escalated'
  | 'blocked'
  | 'queued_for_implementation'
  | 'implementing'
  | 'replan_required'
  | 'pr_open'
  | 'completed'
  | 'failed';

export type ArtifactStage = 'qualification' | 'plan' | 'review' | 'implementation';

export type NotificationStatus = 'pending' | 'posting' | 'posted' | 'failed';

export type NotificationType =
  | 'review_blocked'
  | 'review_escalated'
  | 'branch_drift'
  | 'run_failed'
  | 'budget_exceeded'
  | 'completed';
```

Design notes:
- Union types (not TS enums) — matches the existing codebase pattern where `TaskManagement['status']` is a string union.
- `OneShotState` matches the 14 states defined in the architecture plan.
- `NotificationType` covers every notification scenario that occurs after a OneShot run exists. Qualification failures stay on the legacy `task_management` result path.

### Row interfaces

```typescript
export interface OneShotRun {
  id: number;
  jira_key: string;
  source_task_management_id: number;
  customer_id: number;
  repo_id: number;
  branch_name: string;
  base_commit_sha: string;
  state: OneShotState;
  max_review_loops: number;
  review_loop_count: number;
  current_plan_version: number | null;
  current_review_version: number | null;
  current_implementation_version: number | null;
  current_pr_url: string | null;
  final_disposition: string | null;
  last_error: string | null;
  max_total_tokens: number;
  total_tokens_used: number;
  created_at: Date;
  updated_at: Date;
}

export interface OneShotArtifact {
  id: number;
  oneshot_run_id: number;
  stage: ArtifactStage;
  version: number;
  status: string;
  s3_bucket: string;
  s3_key: string;
  provider: string | null;
  model: string | null;
  metadata_json: Record<string, unknown> | null;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
}

export interface OneShotNotification {
  id: number;
  oneshot_run_id: number;
  jira_key: string;
  notification_type: NotificationType;
  body_markdown: string;
  status: NotificationStatus;
  error: string | null;
  created_at: Date;
  posted_at: Date | null;
}
```

Design notes:
- `metadata_json` is `Record<string, unknown>` — stage-specific shapes are validated by consumers, not the type system. Keeps the DB layer generic.
- Nullable fields use `| null` (not optional `?`) because DB rows always return the column, just as `null`.
- `active_jira_key` is an internal generated column and is intentionally omitted from the public `OneShotRun` interface.

---

## 3. DB Access Layer: `src/oneshot/database/`

### Facade: `src/oneshot/database/index.ts`

```typescript
import type { Pool } from 'mysql2/promise';
import { OneShotRunsDB } from './runs.js';
import { OneShotArtifactsDB } from './artifacts.js';
import { OneShotNotificationsDB } from './notifications.js';

export class OneShotDatabase {
  readonly runs: OneShotRunsDB;
  readonly artifacts: OneShotArtifactsDB;
  readonly notifications: OneShotNotificationsDB;

  constructor(pool: Pool) {
    this.runs = new OneShotRunsDB(pool);
    this.artifacts = new OneShotArtifactsDB(pool);
    this.notifications = new OneShotNotificationsDB(pool);
  }
}
```

Usage from any consumer:
```typescript
import { getDatabase } from '../orchestrator/database.js';
import { OneShotDatabase } from './database/index.js';

const osDb = new OneShotDatabase(getDatabase().getPool());
const run = await osDb.runs.getActiveRunByJiraKey('PROJ-123');
```

### Runs: `src/oneshot/database/runs.ts`

| Method | Purpose | Pattern |
|--------|---------|---------|
| `createRun(data)` | Insert new run, return id | Simple insert |
| `getRunById(id)` | Fetch by PK | Simple select |
| `getActiveRunByJiraKey(jiraKey)` | Fetch active run for a ticket | Simple select |
| `getStuckQueuedRuns(minutesThreshold?)` | Reconciliation — find runs stuck in `queued_for_*` | Select with `LIKE` + interval |
| `claimQueuedRun(id, fromState, toState)` | Atomic state transition for concurrent consumers | `UPDATE WHERE state = ?`, returns boolean |
| `updateRunState(id, state, updates?)` | Simple state update for single-consumer flows | Simple update |
| `incrementReviewLoop(id)` | Bump `review_loop_count` | `SET review_loop_count = review_loop_count + 1` |
| `addTokenUsage(id, tokensUsed)` | Accumulate token spend | `SET total_tokens_used = total_tokens_used + ?` |
| `checkTokenBudget(id)` | Check if run is within budget | Select, compare `total_tokens_used < max_total_tokens` |

`claimQueuedRun` is the only method that enforces a state precondition. All others are simple CRUD. This matches the existing `claimTaskForProcessing` / `claimTaskForJiraPost` pattern in `database.ts`.

### Artifacts: `src/oneshot/database/artifacts.ts`

| Method | Purpose | Pattern |
|--------|---------|---------|
| `upsertArtifact(data)` | Create or update on retry | `INSERT ... ON DUPLICATE KEY UPDATE` |
| `getArtifact(runId, stage, version)` | Fetch specific version | Simple select |
| `getLatestArtifact(runId, stage)` | Latest version for a stage | `ORDER BY version DESC LIMIT 1` |
| `getArtifactsForRun(runId)` | All artifacts for a run | `ORDER BY created_at` |

The upsert is the key method. On retry, the unique constraint on `(oneshot_run_id, stage, version)` triggers the update path. S3 content is overwritten at the same deterministic key.

### Notifications: `src/oneshot/database/notifications.ts`

| Method | Purpose | Pattern |
|--------|---------|---------|
| `createNotification(data)` | Insert new notification | Simple insert |
| `getPendingNotifications(limit?)` | Fetch pending for poster loop | `WHERE status = 'pending'` |
| `claimNotificationForPosting(id)` | Atomic claim | `UPDATE WHERE status = 'pending'`, returns boolean |
| `markNotificationPosted(id)` | Mark success | Set `status = 'posted'`, `posted_at = NOW()` |
| `markNotificationFailed(id, error)` | Mark failure | Set `status = 'failed'`, error text |
| `releaseNotificationClaim(id)` | Release on transient failure | `posting` back to `pending` |

Same atomic claim pattern as the existing `claimTaskForJiraPost` / `releaseTaskClaim` in the orchestrator.

---

## 4. What Phase 1 does NOT include

- No `QUALIFIER` agent or worker (Phase 2)
- No SQS integration (Phase 2+)
- No service layer / workflow orchestration (Phase 2)
- No `agents` table seed for QUALIFIER (Phase 2)
- No modifications to the existing `Database` class or orchestrator
- No PFOS exclusivity routing (Phase 2)

Phase 1 is purely the schema and data access foundation.

---

## 5. Integration point

The only touch point with the existing codebase is pool injection:

```typescript
const osDb = new OneShotDatabase(getDatabase().getPool());
```

The existing `Database` class already exposes `getPool()`. No other changes to existing code are required for Phase 1.

---

## 6. Migration application

Run manually or via deployment:

```bash
mysql -h <host> -u <user> -p Specter < db/migrations/005_oneshot_schema.sql
```

The migration is idempotent (`CREATE TABLE IF NOT EXISTS`). The view uses `CREATE OR REPLACE`.
