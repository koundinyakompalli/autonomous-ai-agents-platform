# Compose Sessions — Phase 1: Session Skeleton & EvidenceProvider Seam — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the Compose→draft integration end-to-end: a Compose session whose only source is a typed-in note can be handed off and produce a `draft_ready` card on the existing Spec Board, flowing through the *unchanged* `generateDraft` pipeline.

**Architecture:** Compose is a new front-half that reuses the existing `generateDraft` back-half. We invert `generateDraft`'s one Jira-specific dependency (`evidenceCollector.collect`) into a pluggable `EvidenceProvider` selected by a new `origin` column on `spec_factory_sources`. The Louise path keeps `JiraEvidenceProvider` (today's collector, behavior unchanged); the Compose path uses a new `ComposeEvidenceProvider` that builds an `EvidenceManifest` from session sources. For `origin='compose'`, `generateDraft` treats qualification as pre-satisfied (no autonomous reject) and does not hard-fail on zero repos.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Node 20, Express, MySQL (`mysql2/promise`), Vitest, Zod. Backend lives in `src/spec-factory/`.

**Scope of this phase:** migrations + new tables, `compose-database.ts`, `compose-service.ts` (create/list/get/addNote/handoff), `ComposeEvidenceProvider`, the `generateDraft` seam refactor, `compose-routes.ts`, and server wiring. **NOT in this phase:** file uploads / presigned S3, the markitdown sidecar, voxtral, SSE streaming, the live Claude chat agent, the frontend modal/panels. Those are Phases 2–4.

**Conventions to follow (verified in the existing code):**
- ESM imports use `.js` suffixes even for `.ts` files (e.g. `import { x } from "./types.js"`).
- Tests are colocated `*.test.ts`, run with Vitest, use mock `PoolLike` / injected collaborators (see `src/spec-factory/service.test.ts`, `database.test.ts`).
- DB JSON columns are written with `CAST(? AS JSON)` and `JSON.stringify(...)`.
- Run a single test file: `npx vitest run src/spec-factory/<file>.test.ts`.
- Typecheck the whole project: `npm run build` (`tsc`).
- Migrations are plain `.sql` files in `db/migrations/NNN_name.sql`, applied out-of-band (CI does not run them). Use `CREATE TABLE IF NOT EXISTS` and the guarded `information_schema` + `PREPARE`/`EXECUTE` pattern for `ALTER` (see `db/migrations/033_spec_factory_evidence_archive.sql`). Mirror every change into `db/schema.sql`.

---

## File Structure

**Create:**
- `db/migrations/037_compose_sessions.sql` — `origin` column on `spec_factory_sources`; new `compose_sessions`, `compose_session_sources`, `compose_session_messages` tables.
- `src/spec-factory/compose-types.ts` — Zod enums + TS interfaces for sessions/sources/messages.
- `src/spec-factory/compose-database.ts` — `ComposeRepository` (CRUD for the three new tables).
- `src/spec-factory/compose-database.test.ts`
- `src/spec-factory/compose-evidence-provider.ts` — `ComposeEvidenceProvider` (builds `EvidenceManifest` from a session).
- `src/spec-factory/compose-evidence-provider.test.ts`
- `src/spec-factory/compose-service.ts` — `ComposeService` (create/list/get/addNote/handoff).
- `src/spec-factory/compose-service.test.ts`
- `src/spec-factory/compose-routes.ts` — `createComposeRouter`.
- `src/spec-factory/compose-routes.test.ts`

**Modify:**
- `src/spec-factory/types.ts` — add `SourceOrigin` enum; add `origin` to `SpecFactorySourceSummary`.
- `src/spec-factory/database.ts` — add `origin` to `SourceRow` + `mapSource`; add `originForSource(sourceId)`; extend `upsertSource` to accept optional `origin`; add `createComposeSource`.
- `src/spec-factory/service.ts` — refactor `generateDraft` to select an `EvidenceProvider` by `origin` and branch qualification for compose; add a constructor option for a compose provider + a `getSourceOrigin` lookup; expose `requestDraftGeneration` reuse.
- `src/spec-factory/evidence.ts` — add `buildComposeEvidenceManifest(...)` helper (a non-Jira manifest builder).
- `src/spec-factory/server.ts` — construct `ComposeRepository`, `ComposeEvidenceProvider`, `ComposeService`; pass the compose provider to `SpecFactoryService`; mount `createComposeRouter`.

---

## Task 1: Migration 037 — origin column + compose tables

**Files:**
- Create: `db/migrations/037_compose_sessions.sql`
- Modify: `db/schema.sql` (append the same tables + note the column)

- [ ] **Step 1: Write the migration**

Create `db/migrations/037_compose_sessions.sql`:

```sql
-- Migration 037: Compose sessions for Spec Factory (Phase 1 skeleton).

-- 1. Add `origin` to spec_factory_sources (guarded, online).
SET @col_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'spec_factory_sources'
    AND column_name = 'origin'
);
SET @ddl := IF(
  @col_exists = 0,
  "ALTER TABLE spec_factory_sources ADD COLUMN origin ENUM('louise','compose') NOT NULL DEFAULT 'louise' AFTER state, ALGORITHM=INPLACE, LOCK=NONE",
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 2. compose_sessions
CREATE TABLE IF NOT EXISTS compose_sessions (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  name                VARCHAR(200) NOT NULL,
  created_by          VARCHAR(120) NULL,
  created_by_display  VARCHAR(200) NULL,
  status              ENUM('draft','ready','handed_off','archived') NOT NULL DEFAULT 'draft',
  claude_session_id   VARCHAR(120) NULL,
  source_id           BIGINT       NULL,
  readiness_json      JSON         NULL,
  s3_prefix           VARCHAR(300) NOT NULL,
  workspace_path      VARCHAR(400) NOT NULL,
  created_at          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_compose_sessions_source
    FOREIGN KEY (source_id) REFERENCES spec_factory_sources(id),
  INDEX idx_compose_sessions_status_updated (status, updated_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. compose_session_sources
CREATE TABLE IF NOT EXISTS compose_session_sources (
  id                 BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id         BIGINT       NOT NULL,
  kind               ENUM('file','youtube','chat','note') NOT NULL,
  original_filename  VARCHAR(400) NULL,
  mime_type          VARCHAR(160) NULL,
  size_bytes         BIGINT       NULL,
  source_url         VARCHAR(2000) NULL,
  s3_key_raw         VARCHAR(500) NULL,
  converter          ENUM('markitdown','voxtral','none') NOT NULL DEFAULT 'none',
  markdown_path      VARCHAR(500) NULL,
  conversion_status  ENUM('pending','converting','converted','unsupported','failed') NOT NULL DEFAULT 'pending',
  error_message      TEXT         NULL,
  created_at         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_compose_session_sources_session
    FOREIGN KEY (session_id) REFERENCES compose_sessions(id),
  INDEX idx_compose_session_sources_session (session_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. compose_session_messages
CREATE TABLE IF NOT EXISTS compose_session_messages (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id  BIGINT       NOT NULL,
  role        ENUM('user','assistant','system') NOT NULL,
  content     MEDIUMTEXT   NOT NULL,
  created_at  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_compose_session_messages_session
    FOREIGN KEY (session_id) REFERENCES compose_sessions(id),
  INDEX idx_compose_session_messages_session (session_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @col_exists := NULL;
SET @ddl := NULL;
```

- [ ] **Step 2: Mirror into `db/schema.sql`**

Append the three `CREATE TABLE` blocks above to `db/schema.sql` (the `IF NOT EXISTS` forms are fine), and update the `spec_factory_sources` `CREATE TABLE` in `schema.sql` to include the `origin` column inline:

```sql
  state               ENUM('candidate','drafting','draft_ready','approved','oneshot_submitted','needs_attention','not_qualified','archived') NOT NULL DEFAULT 'candidate',
  origin              ENUM('louise','compose') NOT NULL DEFAULT 'louise',
```

(Insert the `origin` line immediately after the `state` line in the existing `spec_factory_sources` definition in `schema.sql`.)

- [ ] **Step 3: Verify SQL parses (lint by eye + grep)**

Run: `grep -c "CREATE TABLE IF NOT EXISTS compose_" db/migrations/037_compose_sessions.sql`
Expected: `3`

- [ ] **Step 4: Commit**

```bash
git add db/migrations/037_compose_sessions.sql db/schema.sql
git commit -m "feat(compose): add migration 037 — origin column + compose session tables"
```

---

## Task 2: Compose types

**Files:**
- Create: `src/spec-factory/compose-types.ts`
- Test: `src/spec-factory/compose-types.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/spec-factory/compose-types.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  ComposeSessionStatusSchema,
  ComposeSourceKindSchema,
  composeSourceJiraKey,
} from "./compose-types.js";

describe("compose-types", () => {
  it("accepts valid session statuses", () => {
    expect(ComposeSessionStatusSchema.parse("draft")).toBe("draft");
    expect(ComposeSessionStatusSchema.parse("handed_off")).toBe("handed_off");
  });

  it("rejects unknown source kinds", () => {
    expect(ComposeSourceKindSchema.safeParse("pdf").success).toBe(false);
    expect(ComposeSourceKindSchema.safeParse("note").success).toBe(true);
  });

  it("mints a synthetic source key that matches the Spec Factory regex", () => {
    const key = composeSourceJiraKey(42);
    expect(key).toBe("COMPOSE-42");
    expect(/^[A-Z][A-Z0-9]+-\d+$/.test(key)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/spec-factory/compose-types.test.ts`
Expected: FAIL — cannot find module `./compose-types.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/spec-factory/compose-types.ts`:

```ts
import { z } from "zod";

export const ComposeSessionStatusSchema = z.enum([
  "draft",
  "ready",
  "handed_off",
  "archived",
]);
export type ComposeSessionStatus = z.infer<typeof ComposeSessionStatusSchema>;

export const ComposeSourceKindSchema = z.enum([
  "file",
  "youtube",
  "chat",
  "note",
]);
export type ComposeSourceKind = z.infer<typeof ComposeSourceKindSchema>;

export const ComposeConverterSchema = z.enum(["markitdown", "voxtral", "none"]);
export type ComposeConverter = z.infer<typeof ComposeConverterSchema>;

export const ComposeConversionStatusSchema = z.enum([
  "pending",
  "converting",
  "converted",
  "unsupported",
  "failed",
]);
export type ComposeConversionStatus = z.infer<
  typeof ComposeConversionStatusSchema
>;

export const ComposeMessageRoleSchema = z.enum([
  "user",
  "assistant",
  "system",
]);
export type ComposeMessageRole = z.infer<typeof ComposeMessageRoleSchema>;

export interface ComposeReadiness {
  ready: boolean;
  openQuestions: string[];
  summary: string;
}

export interface ComposeSessionSummary {
  id: number;
  name: string;
  createdBy: string | null;
  createdByDisplay: string | null;
  status: ComposeSessionStatus;
  claudeSessionId: string | null;
  sourceId: number | null;
  readiness: ComposeReadiness | null;
  s3Prefix: string;
  workspacePath: string;
  sourceCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ComposeSessionSourceSummary {
  id: number;
  sessionId: number;
  kind: ComposeSourceKind;
  originalFilename: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  sourceUrl: string | null;
  s3KeyRaw: string | null;
  converter: ComposeConverter;
  markdownPath: string | null;
  conversionStatus: ComposeConversionStatus;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ComposeSessionMessageSummary {
  id: number;
  sessionId: number;
  role: ComposeMessageRole;
  content: string;
  createdAt: string;
}

/** Synthetic Spec Factory source key for a handed-off compose session. */
export function composeSourceJiraKey(sessionId: number): string {
  return `COMPOSE-${sessionId}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/spec-factory/compose-types.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/spec-factory/compose-types.ts src/spec-factory/compose-types.test.ts
git commit -m "feat(compose): add compose-types with Zod enums and synthetic key helper"
```

---

## Task 3: Add `origin` to the Spec Factory source model

**Files:**
- Modify: `src/spec-factory/types.ts`
- Modify: `src/spec-factory/database.ts` (`SourceRow`, `mapSource`)
- Test: `src/spec-factory/database.test.ts` (add a case)

- [ ] **Step 1: Write the failing test**

Add to `src/spec-factory/database.test.ts` (inside the top-level `describe`, near the other source-mapping tests). First confirm the helper used to build mock pools — search the file for `function mockPool` or how `SpecFactoryRepository` is constructed in tests, and follow that exact pattern. Add:

```ts
it("maps the origin column on board sources, defaulting to louise", async () => {
  const pool = {
    query: vi.fn().mockResolvedValue([
      [
        {
          id: 1,
          source_jira_key: "COMPOSE-1",
          source_summary: "Brainstormed idea",
          source_status: null,
          loe_hours: null,
          state: "draft_ready",
          origin: "compose",
          approved_epic_key: null,
          qualification_reasons_json: null,
          error_message: null,
          updated_at: "2026-06-02T00:00:00.000Z",
        },
      ],
      [],
    ]),
    getConnection: vi.fn(),
  };
  const repo = new SpecFactoryRepository(pool as never);
  const sources = await repo.listLouiseBoardSources();
  expect(sources[0].origin).toBe("compose");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/spec-factory/database.test.ts`
Expected: FAIL — `origin` is not a property of `SpecFactorySourceSummary` (TS error) / `sources[0].origin` is `undefined`.

- [ ] **Step 3: Implement — types.ts**

In `src/spec-factory/types.ts`, add the enum near the other schemas (after `SourceStateSchema`):

```ts
export const SourceOriginSchema = z.enum(["louise", "compose"]);
export type SourceOrigin = z.infer<typeof SourceOriginSchema>;
```

Add `origin` to `SpecFactorySourceSummary` (after `state`):

```ts
export interface SpecFactorySourceSummary {
  id: number;
  sourceJiraKey: string;
  sourceSummary: string;
  sourceStatus: string | null;
  loeHours: number | null;
  state: SourceState;
  origin: SourceOrigin;
  approvedEpicKey: string | null;
  qualificationReasons: QualificationReason[];
  errorMessage: string | null;
  updatedAt: string;
}
```

- [ ] **Step 4: Implement — database.ts**

In `src/spec-factory/database.ts`:

(a) Add `origin` to `SourceRow` (after `state`):

```ts
  state: SpecFactorySourceSummary["state"];
  origin: SpecFactorySourceSummary["origin"];
```

(b) Add `origin` to `mapSource` (after `state: row.state,`), defaulting defensively:

```ts
    state: row.state,
    origin: row.origin === "compose" ? "compose" : "louise",
```

(c) Add `origin` to the three source `SELECT` column lists so the row is populated. Update each of these queries to select `origin`:
- `listLouiseBoardSources` (the `SELECT id, source_jira_key, ... state, ...` list) → add `origin,` after `state,`
- `getSourceById` (the `SELECT s.id, ... s.state, ...`) → add `s.origin,` after `s.state,`
- `listOneShotSubmissions` and `listArchivedSources` SELECT lists → add `origin,` after `state,`

Example for `listLouiseBoardSources`:

```ts
      `SELECT id, source_jira_key, source_summary, source_status, loe_hours,
              state, origin, approved_epic_key, qualification_reasons_json,
              error_message, updated_at
       FROM spec_factory_sources
       WHERE state NOT IN ('oneshot_submitted', 'archived')
       ORDER BY updated_at DESC, id DESC
       LIMIT 200`,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/spec-factory/database.test.ts`
Expected: PASS, including the new case.

- [ ] **Step 6: Typecheck**

Run: `npm run build`
Expected: no errors. (If other test fixtures construct `SpecFactorySourceSummary` literals without `origin`, add `origin: "louise"` to them — search `src/spec-factory` for `state: "` in test files and fix the literal source summaries.)

- [ ] **Step 7: Commit**

```bash
git add src/spec-factory/types.ts src/spec-factory/database.ts src/spec-factory/database.test.ts
git commit -m "feat(compose): add origin to Spec Factory source model"
```

---

## Task 4: `createComposeSource` on the repository

**Files:**
- Modify: `src/spec-factory/database.ts`
- Test: `src/spec-factory/database.test.ts`

A compose handoff needs a `spec_factory_sources` row with `origin='compose'`, `state='drafting'`, and the synthetic `COMPOSE-<id>` key. `upsertSource` hardcodes `state='candidate'` and no origin, so we add a dedicated method.

- [ ] **Step 1: Write the failing test**

Add to `src/spec-factory/database.test.ts`:

```ts
it("createComposeSource inserts a compose-origin source and returns its id", async () => {
  const query = vi
    .fn()
    // INSERT
    .mockResolvedValueOnce([{ insertId: 77, affectedRows: 1 }, []])
    // SELECT id
    .mockResolvedValueOnce([[{ id: 77 }], []]);
  const pool = { query, getConnection: vi.fn() };
  const repo = new SpecFactoryRepository(pool as never);

  const id = await repo.createComposeSource({
    sourceJiraKey: "COMPOSE-5",
    sourceSummary: "Brainstormed enrollment idea",
  });

  expect(id).toBe(77);
  const insertSql = String(query.mock.calls[0][0]);
  expect(insertSql).toContain("INSERT INTO spec_factory_sources");
  expect(insertSql).toContain("'compose'");
  expect(insertSql).toContain("'drafting'");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/spec-factory/database.test.ts`
Expected: FAIL — `repo.createComposeSource is not a function`.

- [ ] **Step 3: Implement**

Add to `SpecFactoryRepository` in `src/spec-factory/database.ts` (near `upsertSource`):

```ts
  async createComposeSource(input: {
    sourceJiraKey: string;
    sourceSummary: string;
  }): Promise<number> {
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `INSERT INTO spec_factory_sources
       (source_jira_key, source_summary, source_status, source_labels_json,
        loe_hours, state, origin, last_seen_at)
       VALUES (?, ?, NULL, CAST('[]' AS JSON), NULL, 'drafting', 'compose', CURRENT_TIMESTAMP(3))`,
      [input.sourceJiraKey, input.sourceSummary],
    );

    if (result.insertId) return result.insertId;

    const [rows] = await this.pool.query<
      Array<mysql.RowDataPacket & { id: number }>
    >(`SELECT id FROM spec_factory_sources WHERE source_jira_key = ? LIMIT 1`, [
      input.sourceJiraKey,
    ]);
    const id = rows[0]?.id;
    if (!id) {
      throw new Error(
        `Failed to resolve compose source ${input.sourceJiraKey}`,
      );
    }
    return id;
  }

  async getSourceOrigin(sourceId: number): Promise<"louise" | "compose"> {
    const [rows] = await this.pool.query<
      Array<mysql.RowDataPacket & { origin: string }>
    >(`SELECT origin FROM spec_factory_sources WHERE id = ? LIMIT 1`, [
      sourceId,
    ]);
    return rows[0]?.origin === "compose" ? "compose" : "louise";
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/spec-factory/database.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/spec-factory/database.ts src/spec-factory/database.test.ts
git commit -m "feat(compose): add createComposeSource and getSourceOrigin to repository"
```

---

## Task 5: `buildComposeEvidenceManifest` helper

**Files:**
- Modify: `src/spec-factory/evidence.ts`
- Test: `src/spec-factory/evidence.test.ts`

The existing `buildEvidenceManifest` requires `JiraTicketData`. Compose has no ticket, so we add a sibling builder that takes plain compose inputs and produces the same `EvidenceManifest` shape.

- [ ] **Step 1: Write the failing test**

Add to `src/spec-factory/evidence.test.ts`:

```ts
import { buildComposeEvidenceManifest } from "./evidence.js";

describe("buildComposeEvidenceManifest", () => {
  it("builds a manifest from compose note sources", () => {
    const manifest = buildComposeEvidenceManifest({
      sourceJiraKey: "COMPOSE-9",
      sourceSummary: "Add export to billing",
      sources: [
        { filename: "chat.md", content: "We want CSV export for invoices." },
        { filename: "notes-1.md", content: "Repo is billing-service." },
      ],
    });

    expect(manifest.sourceJiraKey).toBe("COMPOSE-9");
    expect(manifest.sourceSummary).toBe("Add export to billing");
    expect(manifest.sourceStatus).toBeNull();
    expect(manifest.artifacts).toHaveLength(2);
    expect(manifest.artifacts[0].filename).toBe("chat.md");
    expect(manifest.artifacts[0].content).toContain("CSV export");
    expect(manifest.comments).toEqual([]);
    expect(Array.isArray(manifest.warnings)).toBe(true);
  });
});
```

(If `evidence.test.ts` does not already import `describe`/`it`/`expect`, add `import { describe, expect, it } from "vitest";` at the top — match the file's existing import style.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/spec-factory/evidence.test.ts`
Expected: FAIL — `buildComposeEvidenceManifest` is not exported.

- [ ] **Step 3: Implement**

Add to `src/spec-factory/evidence.ts` (after `buildEvidenceManifest`):

```ts
export interface ComposeEvidenceSourceInput {
  filename: string;
  content: string;
}

export function buildComposeEvidenceManifest(input: {
  sourceJiraKey: string;
  sourceSummary: string;
  sources: ComposeEvidenceSourceInput[];
  repoReferences?: SpecFactoryRepoReferenceManifest;
  repoClassifierContext?: EvidenceManifest["repoClassifierContext"];
}): EvidenceManifest {
  const artifacts: EvidenceArtifact[] = input.sources.map((source) => ({
    kind: artifactKind(source.filename),
    filename: source.filename,
    content: source.content,
    isPriority: false,
    extractionStatus: "extracted",
  }));

  const descriptionMarkdown = input.sources
    .map((source) => `## ${source.filename}\n\n${source.content}`)
    .join("\n\n");

  const loe = extractLoeHours(descriptionMarkdown);

  return {
    sourceJiraKey: input.sourceJiraKey,
    sourceSummary: input.sourceSummary,
    sourceStatus: null,
    sourceLabels: [],
    descriptionMarkdown,
    loeHours: loe,
    loeSource: loe !== null ? "compose-sources" : null,
    comments: [],
    artifacts,
    repoReferences: input.repoReferences,
    repoClassifierContext: input.repoClassifierContext,
    warnings: [...(input.repoReferences?.warnings ?? [])],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/spec-factory/evidence.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/spec-factory/evidence.ts src/spec-factory/evidence.test.ts
git commit -m "feat(compose): add buildComposeEvidenceManifest"
```

---

## Task 6: `ComposeRepository` (compose-database.ts)

**Files:**
- Create: `src/spec-factory/compose-database.ts`
- Test: `src/spec-factory/compose-database.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/spec-factory/compose-database.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { ComposeRepository } from "./compose-database.js";

describe("ComposeRepository", () => {
  it("createSession inserts and returns the session id", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([{ insertId: 3, affectedRows: 1 }, []]);
    const repo = new ComposeRepository({ query, getConnection: vi.fn() } as never);

    const id = await repo.createSession({
      name: "Billing export",
      createdBy: "kompallik",
      createdByDisplay: "Koundinya",
      s3Prefix: "compose/3/",
      workspacePath: "/mnt/efs/spec-factory/compose/3",
    });

    expect(id).toBe(3);
    expect(String(query.mock.calls[0][0])).toContain(
      "INSERT INTO compose_sessions",
    );
  });

  it("addNoteSource inserts a note source row", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([{ insertId: 12, affectedRows: 1 }, []]);
    const repo = new ComposeRepository({ query, getConnection: vi.fn() } as never);

    const id = await repo.addNoteSource({
      sessionId: 3,
      filename: "notes-1.md",
      content: "Repo is billing-service.",
    });

    expect(id).toBe(12);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("INSERT INTO compose_session_sources");
    expect(sql).toContain("'note'");
    expect(sql).toContain("'converted'");
  });

  it("listSessionSourceContents returns filename+content for converted note sources", async () => {
    const query = vi.fn().mockResolvedValueOnce([
      [
        { original_filename: "notes-1.md", content: "Repo is billing-service." },
        { original_filename: "chat.md", content: "We want CSV export." },
      ],
      [],
    ]);
    const repo = new ComposeRepository({ query, getConnection: vi.fn() } as never);

    const sources = await repo.listSessionSourceContents(3);

    expect(sources).toEqual([
      { filename: "notes-1.md", content: "Repo is billing-service." },
      { filename: "chat.md", content: "We want CSV export." },
    ]);
  });

  it("linkSource sets source_id and status=handed_off", async () => {
    const query = vi.fn().mockResolvedValueOnce([{ affectedRows: 1 }, []]);
    const repo = new ComposeRepository({ query, getConnection: vi.fn() } as never);

    await repo.linkSource({ sessionId: 3, sourceId: 88 });

    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("UPDATE compose_sessions");
    expect(sql).toContain("status = 'handed_off'");
    expect(query.mock.calls[0][1]).toEqual([88, 3]);
  });

  it("getSession returns null when not found", async () => {
    const query = vi.fn().mockResolvedValueOnce([[], []]);
    const repo = new ComposeRepository({ query, getConnection: vi.fn() } as never);
    expect(await repo.getSession(999)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/spec-factory/compose-database.test.ts`
Expected: FAIL — cannot find module `./compose-database.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/spec-factory/compose-database.ts`:

```ts
import type mysql from "mysql2/promise";
import { getDatabase } from "../orchestrator/database.js";
import type {
  ComposeSessionMessageSummary,
  ComposeSessionSourceSummary,
  ComposeSessionSummary,
} from "./compose-types.js";
import type { ComposeEvidenceSourceInput } from "./evidence.js";

type PoolLike = Pick<mysql.Pool, "query" | "getConnection">;

interface SessionRow extends mysql.RowDataPacket {
  id: number;
  name: string;
  created_by: string | null;
  created_by_display: string | null;
  status: ComposeSessionSummary["status"];
  claude_session_id: string | null;
  source_id: number | null;
  readiness_json: string | unknown | null;
  s3_prefix: string;
  workspace_path: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface SourceContentRow extends mysql.RowDataPacket {
  original_filename: string | null;
  content: string;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function parseReadiness(
  value: string | unknown | null,
): ComposeSessionSummary["readiness"] {
  if (value === null || value === undefined) return null;
  const raw = typeof value === "string" ? safeJson(value) : value;
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  return {
    ready: Boolean(obj.ready),
    openQuestions: Array.isArray(obj.openQuestions)
      ? obj.openQuestions.filter((q): q is string => typeof q === "string")
      : [],
    summary: typeof obj.summary === "string" ? obj.summary : "",
  };
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export class ComposeRepository {
  constructor(private readonly pool: PoolLike = getDatabase().getPool()) {}

  async createSession(input: {
    name: string;
    createdBy: string | null;
    createdByDisplay: string | null;
    s3Prefix: string;
    workspacePath: string;
  }): Promise<number> {
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `INSERT INTO compose_sessions
       (name, created_by, created_by_display, status, s3_prefix, workspace_path)
       VALUES (?, ?, ?, 'draft', ?, ?)`,
      [
        input.name,
        input.createdBy,
        input.createdByDisplay,
        input.s3Prefix,
        input.workspacePath,
      ],
    );
    return result.insertId;
  }

  async getSession(sessionId: number): Promise<ComposeSessionSummary | null> {
    const [rows] = await this.pool.query<SessionRow[]>(
      `SELECT s.id, s.name, s.created_by, s.created_by_display, s.status,
              s.claude_session_id, s.source_id, s.readiness_json,
              s.s3_prefix, s.workspace_path, s.created_at, s.updated_at,
              (SELECT COUNT(*) FROM compose_session_sources cs
                WHERE cs.session_id = s.id) AS source_count
       FROM compose_sessions s
       WHERE s.id = ?
       LIMIT 1`,
      [sessionId],
    );
    const row = rows[0];
    if (!row) return null;
    return this.mapSession(row);
  }

  async listSessions(): Promise<ComposeSessionSummary[]> {
    const [rows] = await this.pool.query<SessionRow[]>(
      `SELECT s.id, s.name, s.created_by, s.created_by_display, s.status,
              s.claude_session_id, s.source_id, s.readiness_json,
              s.s3_prefix, s.workspace_path, s.created_at, s.updated_at,
              (SELECT COUNT(*) FROM compose_session_sources cs
                WHERE cs.session_id = s.id) AS source_count
       FROM compose_sessions s
       ORDER BY s.updated_at DESC, s.id DESC
       LIMIT 200`,
    );
    return rows.map((row) => this.mapSession(row));
  }

  async addNoteSource(input: {
    sessionId: number;
    filename: string;
    content: string;
  }): Promise<number> {
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `INSERT INTO compose_session_sources
       (session_id, kind, original_filename, converter, conversion_status, markdown_path)
       VALUES (?, 'note', ?, 'none', 'converted', NULL)`,
      [input.sessionId, input.filename],
    );
    // Persist the note body in compose_session_messages-adjacent storage: for the
    // skeleton we store note content inline on the source row via a follow-up table
    // is unnecessary — content is held in the messages/notes flow. To keep the note
    // body queryable in Phase 1, store it as a system message tagged with the filename.
    await this.pool.query(
      `INSERT INTO compose_session_messages (session_id, role, content)
       VALUES (?, 'system', ?)`,
      [input.sessionId, `[[source:${input.filename}]]\n${input.content}`],
    );
    return result.insertId;
  }

  async listSessionSourceContents(
    sessionId: number,
  ): Promise<ComposeEvidenceSourceInput[]> {
    const [rows] = await this.pool.query<SourceContentRow[]>(
      `SELECT cs.original_filename,
              COALESCE(
                SUBSTRING(m.content, LOCATE('\n', m.content) + 1),
                ''
              ) AS content
       FROM compose_session_sources cs
       LEFT JOIN compose_session_messages m
         ON m.session_id = cs.session_id
        AND m.role = 'system'
        AND m.content LIKE CONCAT('[[source:', cs.original_filename, ']]%')
       WHERE cs.session_id = ?
         AND cs.conversion_status = 'converted'
       ORDER BY cs.id ASC`,
      [sessionId],
    );
    return rows.map((row) => ({
      filename: row.original_filename ?? "source.md",
      content: row.content ?? "",
    }));
  }

  async linkSource(input: {
    sessionId: number;
    sourceId: number;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE compose_sessions
       SET source_id = ?, status = 'handed_off'
       WHERE id = ?`,
      [input.sourceId, input.sessionId],
    );
  }

  async appendMessage(input: {
    sessionId: number;
    role: ComposeSessionMessageSummary["role"];
    content: string;
  }): Promise<number> {
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `INSERT INTO compose_session_messages (session_id, role, content)
       VALUES (?, ?, ?)`,
      [input.sessionId, input.role, input.content],
    );
    return result.insertId;
  }

  private mapSession(row: SessionRow): ComposeSessionSummary {
    const sourceCount = Number(
      (row as SessionRow & { source_count?: number }).source_count ?? 0,
    );
    return {
      id: row.id,
      name: row.name,
      createdBy: row.created_by,
      createdByDisplay: row.created_by_display,
      status: row.status,
      claudeSessionId: row.claude_session_id,
      sourceId: row.source_id,
      readiness: parseReadiness(row.readiness_json),
      s3Prefix: row.s3_prefix,
      workspacePath: row.workspace_path,
      sourceCount,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  }
}
```

> **Note on note storage:** Phase 1 stores note bodies as tagged `system` messages (`[[source:<filename>]]\n<body>`) so we don't add a column we'll remove in Phase 2 (when real files store their body as a converted `.md` on disk and `markdown_path` is used). `listSessionSourceContents` reads them back. This is a deliberate skeleton shortcut, documented here so Phase 2 replaces it with workspace-file reads.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/spec-factory/compose-database.test.ts`
Expected: PASS (5 tests). If the `listSessionSourceContents` SQL string assertion is brittle against the real DB, the unit test mocks the result set, so it passes regardless; the SQL is exercised for real in the Phase-1 manual check (Task 10).

- [ ] **Step 5: Commit**

```bash
git add src/spec-factory/compose-database.ts src/spec-factory/compose-database.test.ts
git commit -m "feat(compose): add ComposeRepository for sessions, sources, messages"
```

---

## Task 7: `ComposeEvidenceProvider`

**Files:**
- Create: `src/spec-factory/compose-evidence-provider.ts`
- Test: `src/spec-factory/compose-evidence-provider.test.ts`

This is the seam's Compose half: given a `sourceId` (a `COMPOSE-<id>` source), find its session, read the session sources, and build an `EvidenceManifest`. It implements the same `collect(sourceId)` interface as `SpecFactoryEvidenceCollector`.

- [ ] **Step 1: Write the failing test**

Create `src/spec-factory/compose-evidence-provider.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { ComposeEvidenceProvider } from "./compose-evidence-provider.js";

describe("ComposeEvidenceProvider", () => {
  it("builds an EvidenceManifest from the session's sources", async () => {
    const composeRepository = {
      findSessionBySourceId: vi.fn().mockResolvedValue({
        id: 5,
        name: "Billing export",
        sourceId: 41,
      }),
      listSessionSourceContents: vi.fn().mockResolvedValue([
        { filename: "chat.md", content: "We need CSV export for billing-service." },
      ]),
    };
    const specRepository = {
      getSourceById: vi.fn().mockResolvedValue({
        id: 41,
        sourceJiraKey: "COMPOSE-5",
        sourceSummary: "Billing export",
      }),
    };

    const provider = new ComposeEvidenceProvider(
      composeRepository as never,
      specRepository as never,
    );

    const manifest = await provider.collect(41);

    expect(manifest.sourceJiraKey).toBe("COMPOSE-5");
    expect(manifest.artifacts).toHaveLength(1);
    expect(manifest.artifacts[0].content).toContain("CSV export");
    expect(composeRepository.findSessionBySourceId).toHaveBeenCalledWith(41);
  });

  it("throws when no compose session is linked to the source", async () => {
    const composeRepository = {
      findSessionBySourceId: vi.fn().mockResolvedValue(null),
      listSessionSourceContents: vi.fn(),
    };
    const specRepository = { getSourceById: vi.fn() };
    const provider = new ComposeEvidenceProvider(
      composeRepository as never,
      specRepository as never,
    );

    await expect(provider.collect(999)).rejects.toThrow(/compose session/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/spec-factory/compose-evidence-provider.test.ts`
Expected: FAIL — cannot find module `./compose-evidence-provider.js`.

- [ ] **Step 3: Add `findSessionBySourceId` to `ComposeRepository`**

In `src/spec-factory/compose-database.ts`, add:

```ts
  async findSessionBySourceId(
    sourceId: number,
  ): Promise<ComposeSessionSummary | null> {
    const [rows] = await this.pool.query<SessionRow[]>(
      `SELECT s.id, s.name, s.created_by, s.created_by_display, s.status,
              s.claude_session_id, s.source_id, s.readiness_json,
              s.s3_prefix, s.workspace_path, s.created_at, s.updated_at,
              (SELECT COUNT(*) FROM compose_session_sources cs
                WHERE cs.session_id = s.id) AS source_count
       FROM compose_sessions s
       WHERE s.source_id = ?
       LIMIT 1`,
      [sourceId],
    );
    const row = rows[0];
    return row ? this.mapSession(row) : null;
  }
```

- [ ] **Step 4: Write the provider**

Create `src/spec-factory/compose-evidence-provider.ts`:

```ts
import type { ComposeRepository } from "./compose-database.js";
import type { SpecFactoryRepository } from "./database.js";
import {
  buildComposeEvidenceManifest,
  type EvidenceManifest,
} from "./evidence.js";

type ComposeProviderComposeRepo = Pick<
  ComposeRepository,
  "findSessionBySourceId" | "listSessionSourceContents"
>;
type ComposeProviderSpecRepo = Pick<SpecFactoryRepository, "getSourceById">;

export class ComposeEvidenceProvider {
  constructor(
    private readonly composeRepository: ComposeProviderComposeRepo,
    private readonly specRepository: ComposeProviderSpecRepo,
  ) {}

  async collect(sourceId: number): Promise<EvidenceManifest> {
    const session =
      await this.composeRepository.findSessionBySourceId(sourceId);
    if (!session) {
      throw new Error(
        `No compose session is linked to source ${sourceId}`,
      );
    }

    const source = await this.specRepository.getSourceById(sourceId);
    if (!source) {
      throw new Error(`Spec Factory source ${sourceId} was not found`);
    }

    const sources =
      await this.composeRepository.listSessionSourceContents(session.id);

    return buildComposeEvidenceManifest({
      sourceJiraKey: source.sourceJiraKey,
      sourceSummary: source.sourceSummary,
      sources,
    });
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/spec-factory/compose-evidence-provider.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/spec-factory/compose-evidence-provider.ts src/spec-factory/compose-database.ts src/spec-factory/compose-evidence-provider.test.ts
git commit -m "feat(compose): add ComposeEvidenceProvider"
```

---

## Task 8: Refactor `generateDraft` to select an EvidenceProvider by origin

**Files:**
- Modify: `src/spec-factory/service.ts`
- Test: `src/spec-factory/service.test.ts`

This is the hot-path change. **Write the characterization test FIRST** so the Louise path is provably unchanged, then introduce the seam.

- [ ] **Step 1: Write the characterization test (Louise path unchanged)**

Add to `src/spec-factory/service.test.ts` a test that drives `generateDraft` for a `louise` source and asserts the existing collector is used and a draft is created. Match the file's existing harness for building a `SpecFactoryService` with mocked collaborators (search the file for `new SpecFactoryService(` and copy the closest existing setup). The assertion that matters:

```ts
it("uses the Jira evidence collector for louise-origin sources (characterization)", async () => {
  // ...build mocks as the existing tests do: repository.getSourceById returns
  // a source with origin 'louise' and nextDraftVersion 1; evidenceCollector.collect
  // resolves a manifest; qualifier.qualify resolves { qualified: true, ... };
  // generator.generate resolves a bundle; repository.createDraft resolves an id;
  // repository.getLatestDraft resolves a draft detail.
  await service.generateDraft({ sourceId: 1 });

  expect(jiraEvidenceCollector.collect).toHaveBeenCalledWith(1);
  expect(composeEvidenceProvider.collect).not.toHaveBeenCalled();
  expect(repository.createDraft).toHaveBeenCalledTimes(1);
});
```

Add a sibling test for compose:

```ts
it("uses the compose provider and skips reject for compose-origin sources", async () => {
  repository.getSourceById.mockResolvedValue({
    id: 2,
    sourceJiraKey: "COMPOSE-2",
    sourceSummary: "Idea",
    sourceStatus: null,
    loeHours: null,
    state: "drafting",
    origin: "compose",
    approvedEpicKey: null,
    qualificationReasons: [],
    errorMessage: null,
    updatedAt: "2026-06-02T00:00:00.000Z",
    nextDraftVersion: 1,
  });
  repository.getSourceOrigin.mockResolvedValue("compose");
  // qualifier returns NOT qualified — compose must still draft.
  qualifier.qualify.mockResolvedValue({
    qualified: false,
    reasons: ["needs_information"],
    confidence: 0.2,
    summary: "unsure",
    evidenceRefs: [],
    repoHints: [],
    warnings: [],
    modelMetadata: {},
  });

  await service.generateDraft({ sourceId: 2 });

  expect(composeEvidenceProvider.collect).toHaveBeenCalledWith(2);
  expect(repository.markSourceNotQualified).not.toHaveBeenCalled();
  expect(repository.createDraft).toHaveBeenCalledTimes(1);
});
```

> The existing `service.test.ts` harness must be extended to (a) add `getSourceOrigin` to the repository mock, and (b) construct the service with a `composeEvidenceProvider` option. Wire these mocks into the existing `beforeEach` setup.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/spec-factory/service.test.ts`
Expected: FAIL — compose test fails because `generateDraft` still calls the Jira collector and routes the not-qualified compose source to `markSourceNotQualified`; `getSourceOrigin`/`composeEvidenceProvider` not supported.

- [ ] **Step 3: Add the EvidenceProvider option to the service**

In `src/spec-factory/service.ts`:

(a) Add to the `EvidenceCollector` interface usage a parallel provider type — reuse the existing `EvidenceCollector` interface (it already declares `collect(sourceId): Promise<EvidenceManifest>`).

(b) Add `getSourceOrigin` to the `Repository` `Pick<...>` union (add `| "getSourceOrigin"`).

(c) Add to `SpecFactoryServiceOptions`:

```ts
interface SpecFactoryServiceOptions {
  repoDeepDiveEnabled?: boolean;
  workerId?: string;
  pollIntervalMs?: number;
  boardRefreshTtlMs?: number;
  processingJobStaleMs?: number;
  qualifier?: Qualifier;
  composeEvidenceProvider?: EvidenceCollector;
}
```

(d) Store it in the constructor:

```ts
  private readonly composeEvidenceProvider: EvidenceCollector | null;
```

and in the constructor body:

```ts
    this.composeEvidenceProvider = options.composeEvidenceProvider ?? null;
```

- [ ] **Step 4: Branch `generateDraft` by origin**

In `generateDraft`, replace the fixed collector call and the not-qualified handling. Change:

```ts
      await this.repository.markSourceDrafting(input.sourceId);
      const evidenceManifest = await this.evidenceCollector.collect(
        input.sourceId,
      );
```

to:

```ts
      await this.repository.markSourceDrafting(input.sourceId);
      const origin = await this.repository.getSourceOrigin(input.sourceId);
      const isCompose = origin === "compose";
      const provider =
        isCompose && this.composeEvidenceProvider
          ? this.composeEvidenceProvider
          : this.evidenceCollector;
      const evidenceManifest = await provider.collect(input.sourceId);
```

Then wrap the autonomous-reject block so it is skipped for compose. Change:

```ts
      if (!qualification.qualified) {
        const qualificationReasons = ...
        ...
        return null;
      }
```

to:

```ts
      if (!qualification.qualified && !isCompose) {
        const qualificationReasons = qualification.reasons.length
          ? qualification.reasons
          : (["needs_information"] satisfies QualificationReason[]);
        const message = notQualifiedMessage(
          qualificationReasons,
          evidenceManifest,
          qualification.summary,
        );
        await this.repository.markSourceNotQualified(
          input.sourceId,
          qualificationReasons,
          message,
        );
        await this.repository.recordEvent(
          input.sourceId,
          "draft_generation_not_qualified",
          this.workerId,
          {
            reasons: qualificationReasons,
            message,
            sourceJiraKey: evidenceManifest.sourceJiraKey,
            loeHours: evidenceManifest.loeHours,
          },
        );
        return null;
      }
```

Then soften the zero-repo hard-fail for compose. Change:

```ts
      if (repoContextManifest && contextRepoIds.length === 0) {
        const message = ...
        await this.repository.markSourceNotQualified(input.sourceId, ["needs_repo"], message);
        ...
        return null;
      }
```

to:

```ts
      if (repoContextManifest && contextRepoIds.length === 0 && !isCompose) {
        const message =
          "Spec Factory draft generation requires at least one registered repo workspace";
        await this.repository.markSourceNotQualified(
          input.sourceId,
          ["needs_repo"],
          message,
        );
        await this.repository.recordEvent(
          input.sourceId,
          "draft_generation_not_qualified",
          this.workerId,
          { reasons: ["needs_repo"], message },
        );
        return null;
      }
```

> Everything else in `generateDraft` (qualify call + event recording, repo deep dive, generator, createDraft, the error/finally blocks) stays exactly as is. For compose we still *run* the qualifier (its `repoHints` feed the deep dive) and still record `draft_generation_qualification_completed`; we just don't act on a soft reject.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/spec-factory/service.test.ts`
Expected: PASS — both the Louise characterization test and the compose test, plus all pre-existing service tests.

- [ ] **Step 6: Typecheck**

Run: `npm run build`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/spec-factory/service.ts src/spec-factory/service.test.ts
git commit -m "feat(compose): select EvidenceProvider by origin in generateDraft"
```

---

## Task 9: `ComposeService` (create / list / get / addNote / handoff)

**Files:**
- Create: `src/spec-factory/compose-service.ts`
- Test: `src/spec-factory/compose-service.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/spec-factory/compose-service.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { ComposeService } from "./compose-service.js";

function buildService() {
  const composeRepository = {
    createSession: vi.fn().mockResolvedValue(7),
    getSession: vi.fn().mockResolvedValue({
      id: 7,
      name: "Billing export",
      status: "draft",
      sourceId: null,
      sourceCount: 1,
      s3Prefix: "compose/7/",
      workspacePath: "/mnt/efs/spec-factory/compose/7",
      readiness: null,
      createdBy: null,
      createdByDisplay: null,
      claudeSessionId: null,
      createdAt: "2026-06-02T00:00:00.000Z",
      updatedAt: "2026-06-02T00:00:00.000Z",
    }),
    listSessions: vi.fn().mockResolvedValue([]),
    addNoteSource: vi.fn().mockResolvedValue(12),
    linkSource: vi.fn().mockResolvedValue(undefined),
  };
  const specRepository = {
    createComposeSource: vi.fn().mockResolvedValue(88),
  };
  const draftRequester = {
    requestDraftGeneration: vi.fn().mockResolvedValue({ queued: true }),
  };
  const service = new ComposeService(
    composeRepository as never,
    specRepository as never,
    draftRequester as never,
    { workspaceBase: "/mnt/efs/spec-factory/compose", s3Prefix: "compose" },
  );
  return { service, composeRepository, specRepository, draftRequester };
}

describe("ComposeService", () => {
  it("createSession requires a name and computes workspace + s3 paths", async () => {
    const { service, composeRepository } = buildService();
    const session = await service.createSession({
      name: "Billing export",
      createdBy: null,
      createdByDisplay: null,
    });
    expect(session.id).toBe(7);
    const arg = composeRepository.createSession.mock.calls[0][0];
    expect(arg.s3Prefix).toBe("compose/7/"); // recomputed after insert? see impl note
    expect(arg.workspacePath).toContain("/compose/");
  });

  it("createSession rejects a blank name", async () => {
    const { service } = buildService();
    await expect(
      service.createSession({ name: "  ", createdBy: null, createdByDisplay: null }),
    ).rejects.toThrow(/name/i);
  });

  it("addNote appends a note source", async () => {
    const { service, composeRepository } = buildService();
    await service.addNote({ sessionId: 7, content: "Repo is billing-service." });
    expect(composeRepository.addNoteSource).toHaveBeenCalled();
    const arg = composeRepository.addNoteSource.mock.calls[0][0];
    expect(arg.sessionId).toBe(7);
    expect(arg.content).toContain("billing-service");
  });

  it("handoff mints a compose source and queues draft generation (idempotent)", async () => {
    const { service, composeRepository, specRepository, draftRequester } =
      buildService();

    const result = await service.handoff({ sessionId: 7, actor: "kompallik" });

    expect(specRepository.createComposeSource).toHaveBeenCalledWith({
      sourceJiraKey: "COMPOSE-7",
      sourceSummary: "Billing export",
    });
    expect(composeRepository.linkSource).toHaveBeenCalledWith({
      sessionId: 7,
      sourceId: 88,
    });
    expect(draftRequester.requestDraftGeneration).toHaveBeenCalledWith({
      sourceId: 88,
      actor: "kompallik",
    });
    expect(result.sourceId).toBe(88);
  });

  it("handoff returns the existing source when already handed off", async () => {
    const { service, composeRepository, specRepository } = buildService();
    composeRepository.getSession.mockResolvedValue({
      id: 7,
      name: "Billing export",
      status: "handed_off",
      sourceId: 88,
      sourceCount: 1,
      s3Prefix: "compose/7/",
      workspacePath: "/x",
      readiness: null,
      createdBy: null,
      createdByDisplay: null,
      claudeSessionId: null,
      createdAt: "2026-06-02T00:00:00.000Z",
      updatedAt: "2026-06-02T00:00:00.000Z",
    });

    const result = await service.handoff({ sessionId: 7, actor: "kompallik" });

    expect(result.sourceId).toBe(88);
    expect(specRepository.createComposeSource).not.toHaveBeenCalled();
  });
});
```

> **Impl note for the `s3Prefix` assertion:** since the id is only known after insert, `createSession` inserts with a placeholder prefix then is not re-updated in Phase 1 — instead compute `s3Prefix`/`workspacePath` from the returned id by passing them at insert time is impossible. Resolve this in the implementation by inserting first with empty-ish paths, then issuing one `UPDATE` to set `s3_prefix`/`workspace_path` from the id. Adjust the test's first assertion to check the values passed to that update call instead. (Keep whichever shape the implementation lands on; the test must match the implementation.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/spec-factory/compose-service.test.ts`
Expected: FAIL — cannot find module `./compose-service.js`.

- [ ] **Step 3: Add `updateSessionPaths` to `ComposeRepository`**

In `src/spec-factory/compose-database.ts`, add:

```ts
  async updateSessionPaths(input: {
    sessionId: number;
    s3Prefix: string;
    workspacePath: string;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE compose_sessions
       SET s3_prefix = ?, workspace_path = ?
       WHERE id = ?`,
      [input.s3Prefix, input.workspacePath, input.sessionId],
    );
  }
```

- [ ] **Step 4: Write the service**

Create `src/spec-factory/compose-service.ts`:

```ts
import { composeSourceJiraKey } from "./compose-types.js";
import type { ComposeRepository } from "./compose-database.js";
import type { SpecFactoryRepository } from "./database.js";
import type { ComposeSessionSummary } from "./compose-types.js";

type ComposeServiceComposeRepo = Pick<
  ComposeRepository,
  | "createSession"
  | "updateSessionPaths"
  | "getSession"
  | "listSessions"
  | "addNoteSource"
  | "linkSource"
>;
type ComposeServiceSpecRepo = Pick<SpecFactoryRepository, "createComposeSource">;

interface DraftRequester {
  requestDraftGeneration(input: {
    sourceId: number;
    actor?: string | null;
  }): Promise<unknown>;
}

interface ComposeServiceConfig {
  workspaceBase: string;
  s3Prefix: string;
}

function requireSession(
  session: ComposeSessionSummary | null,
  sessionId: number,
): ComposeSessionSummary {
  if (!session) {
    throw new Error(`Compose session ${sessionId} was not found`);
  }
  return session;
}

export class ComposeService {
  constructor(
    private readonly composeRepository: ComposeServiceComposeRepo,
    private readonly specRepository: ComposeServiceSpecRepo,
    private readonly draftRequester: DraftRequester,
    private readonly config: ComposeServiceConfig,
  ) {}

  async createSession(input: {
    name: string;
    createdBy: string | null;
    createdByDisplay: string | null;
  }): Promise<ComposeSessionSummary> {
    const name = input.name.trim();
    if (!name) {
      throw new Error("Compose session name is required");
    }

    const id = await this.composeRepository.createSession({
      name,
      createdBy: input.createdBy,
      createdByDisplay: input.createdByDisplay,
      s3Prefix: "",
      workspacePath: "",
    });

    const s3Prefix = `${this.config.s3Prefix}/${id}/`;
    const workspacePath = `${this.config.workspaceBase}/${id}`;
    await this.composeRepository.updateSessionPaths({
      sessionId: id,
      s3Prefix,
      workspacePath,
    });

    return requireSession(await this.composeRepository.getSession(id), id);
  }

  async listSessions(): Promise<ComposeSessionSummary[]> {
    return this.composeRepository.listSessions();
  }

  async getSession(sessionId: number): Promise<ComposeSessionSummary> {
    return requireSession(
      await this.composeRepository.getSession(sessionId),
      sessionId,
    );
  }

  async addNote(input: {
    sessionId: number;
    content: string;
  }): Promise<ComposeSessionSummary> {
    const content = input.content.trim();
    if (!content) {
      throw new Error("Compose note content is required");
    }
    const session = requireSession(
      await this.composeRepository.getSession(input.sessionId),
      input.sessionId,
    );
    const filename = `note-${session.sourceCount + 1}.md`;
    await this.composeRepository.addNoteSource({
      sessionId: input.sessionId,
      filename,
      content,
    });
    return requireSession(
      await this.composeRepository.getSession(input.sessionId),
      input.sessionId,
    );
  }

  async handoff(input: {
    sessionId: number;
    actor: string | null;
  }): Promise<{ sourceId: number; session: ComposeSessionSummary }> {
    const session = requireSession(
      await this.composeRepository.getSession(input.sessionId),
      input.sessionId,
    );

    if (session.sourceId) {
      return { sourceId: session.sourceId, session };
    }

    const sourceId = await this.specRepository.createComposeSource({
      sourceJiraKey: composeSourceJiraKey(session.id),
      sourceSummary: session.name,
    });

    await this.composeRepository.linkSource({
      sessionId: session.id,
      sourceId,
    });

    await this.draftRequester.requestDraftGeneration({
      sourceId,
      actor: input.actor,
    });

    return {
      sourceId,
      session: requireSession(
        await this.composeRepository.getSession(input.sessionId),
        input.sessionId,
      ),
    };
  }
}
```

- [ ] **Step 5: Reconcile the test with the implementation**

Update the `createSession` assertions in Step 1 to check `updateSessionPaths` was called with `s3Prefix: "compose/7/"` and `workspacePath: "/mnt/efs/spec-factory/compose/7"` (since paths are set via the update, not the insert).

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/spec-factory/compose-service.test.ts`
Expected: PASS (all cases).

- [ ] **Step 7: Commit**

```bash
git add src/spec-factory/compose-service.ts src/spec-factory/compose-database.ts src/spec-factory/compose-service.test.ts
git commit -m "feat(compose): add ComposeService (create/list/get/addNote/handoff)"
```

---

## Task 10: `compose-routes.ts` + server wiring

**Files:**
- Create: `src/spec-factory/compose-routes.ts`
- Test: `src/spec-factory/compose-routes.test.ts`
- Modify: `src/spec-factory/server.ts`

- [ ] **Step 1: Write the failing test**

Create `src/spec-factory/compose-routes.test.ts` (mirror the style of `routes.test.ts` — search it for how it builds a supertest-like app or calls handlers; if `routes.test.ts` uses `express()` + a real HTTP client, copy that; otherwise call the router via a minimal express app). Minimal version using `express` + `node:http` is overkill — use the same approach `routes.test.ts` already uses. Tests to write:

```ts
import { describe, expect, it, vi } from "vitest";
import express from "express";
import { createComposeRouter } from "./compose-routes.js";

function appWith(service: unknown) {
  const app = express();
  app.use(express.json());
  app.use("/api/spec-factory/compose", createComposeRouter(service as never));
  return app;
}

// Use the same in-process request helper that routes.test.ts uses.
// The assertions below describe the required behavior:

describe("compose routes", () => {
  it("POST /sessions creates a session (201)", async () => {
    const service = {
      createSession: vi.fn().mockResolvedValue({ id: 7, name: "X" }),
    };
    // POST { name: "X" } -> expect 201 and body.id === 7
    // expect service.createSession called with { name: "X", createdBy: null, createdByDisplay: null }
  });

  it("POST /sessions rejects a blank name (400)", async () => {
    const service = {
      createSession: vi
        .fn()
        .mockRejectedValue(new Error("Compose session name is required")),
    };
    // POST { name: "" } -> expect 500 or 400 per handleError; assert error surfaced
  });

  it("POST /sessions/:id/notes adds a note (202)", async () => {
    const service = { addNote: vi.fn().mockResolvedValue({ id: 7 }) };
    // POST { content: "hi" } to /sessions/7/notes -> 202
  });

  it("POST /sessions/:id/handoff returns the minted source (202)", async () => {
    const service = {
      handoff: vi.fn().mockResolvedValue({ sourceId: 88, session: { id: 7 } }),
    };
    // POST /sessions/7/handoff -> 202, body.sourceId === 88
  });

  it("GET /sessions lists sessions (200)", async () => {
    const service = { listSessions: vi.fn().mockResolvedValue([]) };
    // GET /sessions -> 200, body === []
  });
});
```

> Fill the request bodies/assertions using `routes.test.ts`'s existing request mechanism so the style matches exactly. Each `it` must end with concrete `expect` calls on status + body + the mocked service method.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/spec-factory/compose-routes.test.ts`
Expected: FAIL — cannot find module `./compose-routes.js`.

- [ ] **Step 3: Write the router**

Create `src/spec-factory/compose-routes.ts`:

```ts
import { Router } from "express";
import type { Request, Response } from "express";
import type { ComposeService } from "./compose-service.js";
import { positiveInt, actorFromRequest } from "./routes.js";

type ComposeRouteService = Pick<
  ComposeService,
  "createSession" | "listSessions" | "getSession" | "addNote" | "handoff"
>;

function errorPayload(message: string): { error: { message: string } } {
  return { error: { message } };
}

function handleError(res: Response, error: unknown): void {
  if (error instanceof Error && /must be a positive integer/.test(error.message)) {
    res.status(400).json(errorPayload(error.message));
    return;
  }
  if (
    error instanceof Error &&
    /(is required|was not found)/i.test(error.message)
  ) {
    res.status(400).json(errorPayload(error.message));
    return;
  }
  const message = error instanceof Error ? error.message : "Unexpected error";
  res.status(500).json(errorPayload(message));
}

function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function createComposeRouter(service: ComposeRouteService): Router {
  const router = Router();

  router.get("/sessions", async (_req: Request, res: Response) => {
    try {
      res.setHeader("Cache-Control", "no-cache");
      res.json(await service.listSessions());
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post("/sessions", async (req: Request, res: Response) => {
    try {
      const name = typeof req.body?.name === "string" ? req.body.name : "";
      const session = await service.createSession({
        name,
        createdBy: optionalString(req.body?.userName),
        createdByDisplay: optionalString(req.body?.userName),
      });
      res.status(201).json(session);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get("/sessions/:sessionId", async (req: Request, res: Response) => {
    try {
      const sessionId = positiveInt(req.params.sessionId, "sessionId");
      res.json(await service.getSession(sessionId));
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post(
    "/sessions/:sessionId/notes",
    async (req: Request, res: Response) => {
      try {
        const sessionId = positiveInt(req.params.sessionId, "sessionId");
        const content =
          typeof req.body?.content === "string" ? req.body.content : "";
        const session = await service.addNote({ sessionId, content });
        res.status(202).json(session);
      } catch (error) {
        handleError(res, error);
      }
    },
  );

  router.post(
    "/sessions/:sessionId/handoff",
    async (req: Request, res: Response) => {
      try {
        const sessionId = positiveInt(req.params.sessionId, "sessionId");
        const result = await service.handoff({
          sessionId,
          actor: actorFromRequest(req).id,
        });
        res.status(202).json(result);
      } catch (error) {
        handleError(res, error);
      }
    },
  );

  return router;
}
```

> `positiveInt` and `actorFromRequest` are already exported from `routes.ts` (verified). If `actorFromRequest` is not exported, add `export` to it in `routes.ts` as part of this task.

- [ ] **Step 4: Wire into the server**

In `src/spec-factory/server.ts`:

(a) Add imports:

```ts
import { ComposeRepository } from "./compose-database.js";
import { ComposeEvidenceProvider } from "./compose-evidence-provider.js";
import { ComposeService } from "./compose-service.js";
import { createComposeRouter } from "./compose-routes.js";
```

(b) After `const repository = new SpecFactoryRepository(pool);`, add:

```ts
  const composeRepository = new ComposeRepository(pool);
  const composeEvidenceProvider = new ComposeEvidenceProvider(
    composeRepository,
    repository,
  );
```

(c) Pass the compose provider to the service constructor as the options argument (the 8th positional arg is `taskWorkspaceManager` with a default; options is the 9th). Use the default workspace manager and supply options:

```ts
  const service = new SpecFactoryService(
    repository,
    ingestor,
    evidenceCollector,
    repoContextCollector,
    new DraftGenerator(),
    new JiraPublisher(jiraClient),
    new OneShotSubmitter(jiraClient),
    new SpecFactoryTaskWorkspaceManager(),
    { composeEvidenceProvider },
  );
```

Add the import for the workspace manager at the top:

```ts
import { SpecFactoryTaskWorkspaceManager } from "./evidence-workspace.js";
```

(d) Construct the compose service (it needs a `DraftRequester` — the `SpecFactoryService` exposes `requestDraftGeneration`, so pass `service`):

```ts
  const composeService = new ComposeService(
    composeRepository,
    repository,
    service,
    {
      workspaceBase:
        process.env.COMPOSE_WORKSPACE_BASE?.trim() ||
        "/mnt/efs/specter-repo/spec-factory/compose",
      s3Prefix: process.env.COMPOSE_S3_PREFIX?.trim() || "compose",
    },
  );
```

(e) Mount the router (after the existing `app.use("/api/spec-factory", ...)`):

```ts
  app.use("/api/spec-factory/compose", createComposeRouter(composeService));
```

> Order note: in Express, register `/api/spec-factory/compose` BEFORE `/api/spec-factory` is fine because the more specific path is matched first only if registered first; to be safe, register the compose router on its own full path as shown (it does not overlap the Louise routes, which are all under `/api/spec-factory/{louise,sources,drafts,oneshot,archive}`).

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run src/spec-factory/compose-routes.test.ts`
Expected: PASS.

Run: `npm run build`
Expected: no errors.

- [ ] **Step 6: Run the full Spec Factory test suite (no regressions)**

Run: `npx vitest run src/spec-factory`
Expected: PASS — all pre-existing tests plus the new compose tests.

- [ ] **Step 7: Commit**

```bash
git add src/spec-factory/compose-routes.ts src/spec-factory/compose-routes.test.ts src/spec-factory/server.ts
git commit -m "feat(compose): add compose routes and wire ComposeService into the server"
```

---

## Task 11: End-to-end skeleton verification (manual, documented)

**Files:** none (verification only)

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: clean.

- [ ] **Step 2: Full backend test run**

Run: `npx vitest run src/spec-factory`
Expected: all green.

- [ ] **Step 3: Document the manual happy-path (for the PR description)**

Write the following into the PR description as the manual verification steps (these require migration 037 applied to a dev DB and the service running locally on 3012):

```
1. POST /api/spec-factory/compose/sessions { "name": "Billing export" }
   -> 201, { id }
2. POST /api/spec-factory/compose/sessions/<id>/notes
   { "content": "We need CSV export for the billing-service repo. AC: invoices export as CSV; existing PDF export unchanged." }
   -> 202
3. POST /api/spec-factory/compose/sessions/<id>/handoff
   -> 202, { sourceId }
4. GET  /api/spec-factory/louise/candidates
   -> the COMPOSE-<id> source appears; within one processing cycle its state
      becomes draft_ready (origin: "compose").
5. GET  /api/spec-factory/sources/<sourceId>/drafts/latest
   -> 200 with a rendered Epic bundle.
```

- [ ] **Step 4: Commit (plan/PR notes only, if any)**

No code commit required for this task.

---

## Self-Review

**1. Spec coverage (Phase 1 scope only):**
- Session lifecycle (create/list/get) → Tasks 6, 9, 10. ✓
- Session→source mapping via `COMPOSE-<id>` + `origin` column → Tasks 1, 2, 3, 4. ✓
- The `EvidenceProvider` seam + skip-autonomous-reject + soften zero-repo → Tasks 5, 7, 8. ✓
- Handoff into the unchanged pipeline → `draft_ready` → Tasks 9, 11. ✓
- Idempotent handoff → Task 9. ✓
- Note-as-source (skeleton stand-in for uploads) → Tasks 6, 9. ✓
- Deferred to later phases (correctly absent here): presigned uploads, markitdown sidecar, voxtral, SSE chat, live agent, frontend. ✓

**2. Placeholder scan:** No "TBD/TODO/handle errors appropriately" left; every code step has full code. The two `> Note` blocks are deliberate implementation guidance (note-storage shortcut; s3Prefix-after-insert), not placeholders. The routes test (Task 10) intentionally defers to `routes.test.ts`'s existing request mechanism rather than inventing one — the worker must read that file; this is called out explicitly.

**3. Type consistency:**
- `EvidenceManifest` shape used by `buildComposeEvidenceManifest` (Task 5) matches `evidence.ts` exactly (verified against the real interface: `comments`, `artifacts`, `warnings`, `loeSource`, etc.).
- `collect(sourceId): Promise<EvidenceManifest>` — `ComposeEvidenceProvider` (Task 7) matches the existing `EvidenceCollector` interface in `service.ts` (Task 8), so it slots into the same option type.
- `createComposeSource` / `getSourceOrigin` defined in Task 4, consumed in Tasks 8 (service) and 9 (compose-service) with matching signatures.
- `ComposeRepository` methods: `createSession`, `updateSessionPaths`, `getSession`, `listSessions`, `addNoteSource`, `linkSource`, `findSessionBySourceId`, `appendMessage`, `listSessionSourceContents` — defined in Tasks 6/7/9, consumed with matching names in Tasks 7/9.
- `composeSourceJiraKey(id)` (Task 2) used in Task 9; returns `COMPOSE-<id>` (regex-verified in Task 2 test).

**Known follow-ups for Phase 2 (intentional, not gaps):** the note-body-in-`system`-message storage shortcut is replaced by workspace-file reads; `appendMessage`/`claude_session_id`/`readiness_json` are written by the Phase 3 chat loop; per-source upload rows (`kind='file'`, `s3_key_raw`, `converter`, `conversion_status`) are populated by Phase 2's ingestion worker.
