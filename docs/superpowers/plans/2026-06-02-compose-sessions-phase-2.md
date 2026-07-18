# Compose Sessions — Phase 2: Ingestion (uploads + markitdown sidecar + conversion worker) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator add real source material to a Compose session — files (presigned S3 upload), YouTube URLs, and notes — and have each one converted to Markdown in the session workspace, with live per-source status, so the converted sources feed the existing `ComposeEvidenceProvider` at handoff.

**Architecture:** Files upload directly to S3 via presigned PUT (browser → S3, off the ECS request path). A new in-process **conversion worker** claims `pending` `compose_session_sources` rows (the row IS the work queue — claimed via a conditional `UPDATE`, mirroring `claimNextProcessingJob`), pulls the raw object from S3, routes it to a **markitdown Python sidecar** (a second container in the same ECS task, reachable on `localhost:8080`) for all non-audio formats, writes the resulting Markdown to the session's EFS workspace and to a new `markdown_content` column, and flips the row to `converted`/`failed`. Audio (voxtral) is deferred to Phase 4. The Phase-1 note-as-tagged-`system`-message shortcut is replaced by the same `markdown_content` column.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Node 20, Express, MySQL (`mysql2/promise`), Vitest, Zod, `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` (both already deps), Python 3.12 + FastAPI + `markitdown` (sidecar), Terraform, Docker.

**Scope of this phase:** migration 038 (`markdown_content` column + conversion-claim index), the conversion-status/source read-model surfacing, presigned-upload issuance + completion routes, the markitdown sidecar container, the conversion worker, retry/reconvert, and the infra to ship the sidecar (Dockerfile + terraform second container + S3 CORS). **NOT in this phase:** audio/voxtral (Phase 4), the SSE clarification chat + "Analyze Sources"/readiness (Phase 3), and the dashboard React UI (deferred with the rest of the frontend; this phase exposes the API + live-status data the UI will consume). EPub/ZIP/image-OCR ride for free on markitdown but are only smoke-tested here.

**Conventions (verified in the codebase):**
- ESM imports use `.js` suffixes even for `.ts` files.
- Colocated `*.test.ts`, Vitest. Run one file: `npx vitest run src/spec-factory/<file>.test.ts`. Typecheck: `npm run build` (`tsc`).
- DB JSON columns use `CAST(? AS JSON)`; migrations are plain `.sql` in `db/migrations/NNN_name.sql`, applied out-of-band, mirrored into `db/schema.sql`. Use the guarded `information_schema` + `PREPARE`/`EXECUTE` pattern for `ALTER` (see `037_compose_sessions.sql`).
- S3 client comes from `createS3Client()` in `src/utils/awsClients.ts`.
- The conversion worker mirrors the claim/drain pattern in `SpecFactoryRepository.claimNextProcessingJob` + `SpecFactoryService.processQueuedJobs`.
- markitdown reference: https://github.com/microsoft/markitdown — the `markitdown` PyPI package; `MarkItDown().convert(path).text_content`.

---

## Key design decisions (read before starting)

1. **The conversion queue is the `compose_session_sources` row itself**, claimed via a conditional `UPDATE ... SET conversion_status='converting' WHERE id=? AND conversion_status='pending'` (atomic claim — `affectedRows===1` wins). We do NOT reuse `spec_factory_processing_jobs`, because that table's `source_id` is an FK to `spec_factory_sources(id)` (the wrong entity — conversion is per compose source, which has no `spec_factory_sources` row until handoff).
2. **`markdown_content MEDIUMTEXT` (migration 038) replaces the Phase-1 note hack.** The live compose tables are empty (verified against the deployed DB), so there is no backfill. `addNoteSource` writes `markdown_content` directly; the conversion worker writes it for files/URLs; `listSessionSourceContents` reads it directly and the brittle `[[source:...]]` LIKE-join is deleted.
3. **markitdown runs as a second container in the SAME ECS task** (localhost:8080) — no new service/networking/IAM. The Node worker POSTs the raw bytes (or a YouTube URL) and gets Markdown back.
4. **Audio is out of scope here.** The worker routes `audio/*` sources to `conversion_status='unsupported'` with a clear message in Phase 2; Phase 4 swaps that branch for voxtral.

---

## File Structure

**Create:**
- `db/migrations/038_compose_markdown_content.sql` — `markdown_content` column on `compose_session_sources` + a claim index.
- `src/spec-factory/compose-markitdown-client.ts` — thin HTTP client for the sidecar.
- `src/spec-factory/compose-markitdown-client.test.ts`
- `src/spec-factory/compose-uploads.ts` — presigned PUT issuance + raw-object fetch helpers.
- `src/spec-factory/compose-uploads.test.ts`
- `src/spec-factory/compose-conversion.ts` — `ComposeConversionWorker` (claim → convert → persist).
- `src/spec-factory/compose-conversion.test.ts`
- `sidecar/markitdown/app.py` — FastAPI `/convert` + `/health`.
- `sidecar/markitdown/requirements.txt`
- `sidecar/markitdown/test_app.py` — pytest for the sidecar.
- `Dockerfile.compose-markitdown` — the sidecar image.

**Modify:**
- `src/spec-factory/compose-types.ts` — add `markdownContent` to `ComposeSessionSourceSummary`; add a `ComposeUploadTarget` type.
- `src/spec-factory/compose-database.ts` — add `markdown_content` to writes/reads; new methods `createUploadSource`, `markSourceUploaded`, `claimNextPendingSource`, `markSourceConverting/Converted/Failed/Unsupported`, `listSessionSources`, `getSessionSource`, `reconvertSource`; rewrite `addNoteSource`/`listSessionSourceContents` to use `markdown_content`.
- `src/spec-factory/compose-service.ts` — `requestUpload`, `confirmUpload`, `addYoutubeSource`, `listSources`, `reconvert`; kick the conversion worker after enqueue.
- `src/spec-factory/compose-routes.ts` — upload/confirm/youtube/list/reconvert routes.
- `src/spec-factory/compose-routes.test.ts` — cover the new routes.
- `src/spec-factory/server.ts` — construct the markitdown client, S3 client, conversion worker; start its loop; pass deps to `ComposeService`.
- `Dockerfile.spec-factory` — (no change needed; documented why).
- `terraform/spec-factory-ecs.tf` — add the markitdown container to the task def + `COMPOSE_*` env vars.
- `terraform/s3.tf` — CORS on the results bucket for presigned browser PUT.
- `.github/workflows/spec-factory-build-push.yml` — build + push the sidecar image; add the new vitest files.
- `db/schema.sql` — mirror migration 038.

---

## Task 1: Migration 038 — `markdown_content` column + claim index

**Files:**
- Create: `db/migrations/038_compose_markdown_content.sql`
- Modify: `db/schema.sql`

- [ ] **Step 1: Write the migration**

Create `db/migrations/038_compose_markdown_content.sql`:

```sql
-- Migration 038: Compose source markdown_content + conversion claim index (Phase 2).

-- 1. markdown_content holds the converted Markdown for a source (notes, files, URLs).
SET @col_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'compose_session_sources'
    AND column_name = 'markdown_content'
);
SET @ddl := IF(
  @col_exists = 0,
  'ALTER TABLE compose_session_sources ADD COLUMN markdown_content MEDIUMTEXT NULL AFTER markdown_path, ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 2. Index to claim pending sources efficiently (worker queue).
SET @idx_exists := (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'compose_session_sources'
    AND index_name = 'idx_compose_sources_status_id'
);
SET @ddl := IF(
  @idx_exists = 0,
  'ALTER TABLE compose_session_sources ADD INDEX idx_compose_sources_status_id (conversion_status, id), ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists := NULL;
SET @idx_exists := NULL;
SET @ddl := NULL;
```

- [ ] **Step 2: Mirror into `db/schema.sql`**

In `db/schema.sql`, find the `compose_session_sources` `CREATE TABLE` block. Add the column immediately after the `markdown_path` line:

```sql
  markdown_content   MEDIUMTEXT   NULL,
```

And add the index alongside the existing `idx_compose_session_sources_session` index line in that block:

```sql
  INDEX idx_compose_sources_status_id (conversion_status, id),
```

- [ ] **Step 3: Verify**

Run: `grep -c "markdown_content" db/migrations/038_compose_markdown_content.sql`
Expected: `2` (the information_schema check + the ALTER).
Run: `grep -n "markdown_content" db/schema.sql`
Expected: one match inside the `compose_session_sources` block.

- [ ] **Step 4: Commit**

```bash
git add db/migrations/038_compose_markdown_content.sql db/schema.sql
git commit -m "feat(compose): migration 038 — markdown_content column + claim index"
```

---

## Task 2: Compose types — markdownContent + upload target

**Files:**
- Modify: `src/spec-factory/compose-types.ts`
- Test: `src/spec-factory/compose-types.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/spec-factory/compose-types.test.ts`:

```ts
import type { ComposeSessionSourceSummary, ComposeUploadTarget } from "./compose-types.js";

it("ComposeSessionSourceSummary carries markdownContent and ComposeUploadTarget is shaped", () => {
  const source: ComposeSessionSourceSummary = {
    id: 1,
    sessionId: 2,
    kind: "file",
    originalFilename: "spec.pdf",
    mimeType: "application/pdf",
    sizeBytes: 1024,
    sourceUrl: null,
    s3KeyRaw: "compose/2/raw/1-spec.pdf",
    converter: "markitdown",
    markdownPath: null,
    markdownContent: null,
    conversionStatus: "pending",
    errorMessage: null,
    createdAt: "2026-06-02T00:00:00.000Z",
    updatedAt: "2026-06-02T00:00:00.000Z",
  };
  const target: ComposeUploadTarget = {
    sourceId: 1,
    uploadUrl: "https://s3.example/put",
    s3KeyRaw: "compose/2/raw/1-spec.pdf",
    expiresInSeconds: 900,
  };
  expect(source.markdownContent).toBeNull();
  expect(target.sourceId).toBe(1);
});
```

- [ ] **Step 2: Run; verify FAIL** (TS: `markdownContent`/`ComposeUploadTarget` don't exist)

Run: `npx vitest run src/spec-factory/compose-types.test.ts`

- [ ] **Step 3: Implement**

In `src/spec-factory/compose-types.ts`, add `markdownContent: string | null;` to `ComposeSessionSourceSummary` immediately after `markdownPath`:

```ts
  markdownPath: string | null;
  markdownContent: string | null;
```

Add this interface at the end of the file:

```ts
export interface ComposeUploadTarget {
  sourceId: number;
  uploadUrl: string;
  s3KeyRaw: string;
  expiresInSeconds: number;
}
```

- [ ] **Step 4: Run; verify PASS**

Run: `npx vitest run src/spec-factory/compose-types.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/spec-factory/compose-types.ts src/spec-factory/compose-types.test.ts
git commit -m "feat(compose): add markdownContent and ComposeUploadTarget types"
```

---

## Task 3: ComposeRepository — markdown_content, upload sources, conversion claim

**Files:**
- Modify: `src/spec-factory/compose-database.ts`
- Test: `src/spec-factory/compose-database.test.ts`

This rewrites `addNoteSource`/`listSessionSourceContents` to use `markdown_content`, adds a `SourceRow` mapper, and adds the upload + conversion-claim methods.

- [ ] **Step 1: Write the failing tests**

Add to `src/spec-factory/compose-database.test.ts`:

```ts
it("addNoteSource stores markdown_content directly (no tagged message)", async () => {
  const query = vi.fn().mockResolvedValueOnce([{ insertId: 12, affectedRows: 1 }, []]);
  const repo = new ComposeRepository({ query, getConnection: vi.fn() } as never);
  const id = await repo.addNoteSource({ sessionId: 3, filename: "note-1.md", content: "Repo is billing-service." });
  expect(id).toBe(12);
  expect(query).toHaveBeenCalledTimes(1); // single INSERT, no second message insert
  const sql = String(query.mock.calls[0][0]);
  expect(sql).toContain("INSERT INTO compose_session_sources");
  expect(sql).toContain("markdown_content");
  expect(query.mock.calls[0][1]).toContain("Repo is billing-service.");
});

it("listSessionSourceContents reads markdown_content for converted sources", async () => {
  const query = vi.fn().mockResolvedValueOnce([
    [
      { original_filename: "note-1.md", markdown_content: "Repo is billing-service." },
      { original_filename: "spec.pdf", markdown_content: "# Spec\n\nDetails." },
    ],
    [],
  ]);
  const repo = new ComposeRepository({ query, getConnection: vi.fn() } as never);
  const sources = await repo.listSessionSourceContents(3);
  expect(sources).toEqual([
    { filename: "note-1.md", content: "Repo is billing-service." },
    { filename: "spec.pdf", content: "# Spec\n\nDetails." },
  ]);
  const sql = String(query.mock.calls[0][0]);
  expect(sql).toContain("markdown_content");
  expect(sql).not.toContain("[[source:");
});

it("createUploadSource inserts a pending file source and returns id + key", async () => {
  const query = vi.fn().mockResolvedValueOnce([{ insertId: 21, affectedRows: 1 }, []]);
  const repo = new ComposeRepository({ query, getConnection: vi.fn() } as never);
  const id = await repo.createUploadSource({
    sessionId: 4,
    filename: "spec.pdf",
    mimeType: "application/pdf",
    sizeBytes: 2048,
    s3KeyRaw: "compose/4/raw/PENDING-spec.pdf",
    converter: "markitdown",
  });
  expect(id).toBe(21);
  const sql = String(query.mock.calls[0][0]);
  expect(sql).toContain("INSERT INTO compose_session_sources");
  expect(sql).toContain("'file'");
  expect(sql).toContain("'pending'");
});

it("claimNextPendingSource atomically flips one pending row to converting", async () => {
  const query = vi
    .fn()
    // SELECT one pending id
    .mockResolvedValueOnce([[{ id: 7, session_id: 4 }], []])
    // UPDATE ... WHERE conversion_status='pending' -> affectedRows 1
    .mockResolvedValueOnce([{ affectedRows: 1 }, []])
    // SELECT the claimed row
    .mockResolvedValueOnce([[{ id: 7, session_id: 4, kind: "file", original_filename: "spec.pdf", mime_type: "application/pdf", size_bytes: 2048, source_url: null, s3_key_raw: "k", converter: "markitdown", markdown_path: null, markdown_content: null, conversion_status: "converting", error_message: null, created_at: "2026-06-02T00:00:00.000Z", updated_at: "2026-06-02T00:00:00.000Z" }], []]);
  const repo = new ComposeRepository({ query, getConnection: vi.fn() } as never);
  const claimed = await repo.claimNextPendingSource();
  expect(claimed?.id).toBe(7);
  expect(claimed?.conversionStatus).toBe("converting");
  const updateSql = String(query.mock.calls[1][0]);
  expect(updateSql).toContain("conversion_status = 'converting'");
  expect(updateSql).toContain("WHERE id = ?");
  expect(updateSql).toContain("conversion_status = 'pending'");
});

it("claimNextPendingSource returns null when the row was raced away", async () => {
  const query = vi
    .fn()
    .mockResolvedValueOnce([[{ id: 7, session_id: 4 }], []])
    .mockResolvedValueOnce([{ affectedRows: 0 }, []]); // lost the race
  const repo = new ComposeRepository({ query, getConnection: vi.fn() } as never);
  expect(await repo.claimNextPendingSource()).toBeNull();
});

it("markSourceConverted writes markdown_content + markdown_path and status", async () => {
  const query = vi.fn().mockResolvedValueOnce([{ affectedRows: 1 }, []]);
  const repo = new ComposeRepository({ query, getConnection: vi.fn() } as never);
  await repo.markSourceConverted({ sourceId: 7, markdownPath: "/w/sources/7-spec.pdf.md", markdownContent: "# Spec" });
  const sql = String(query.mock.calls[0][0]);
  expect(sql).toContain("conversion_status = 'converted'");
  expect(sql).toContain("markdown_content = ?");
  expect(query.mock.calls[0][1]).toEqual(["/w/sources/7-spec.pdf.md", "# Spec", 7]);
});

it("markSourceFailed and markSourceUnsupported set status + message", async () => {
  const query = vi.fn().mockResolvedValue([{ affectedRows: 1 }, []]);
  const repo = new ComposeRepository({ query, getConnection: vi.fn() } as never);
  await repo.markSourceFailed({ sourceId: 7, errorMessage: "boom" });
  expect(String(query.mock.calls[0][0])).toContain("conversion_status = 'failed'");
  await repo.markSourceUnsupported({ sourceId: 8, errorMessage: "audio not supported yet" });
  expect(String(query.mock.calls[1][0])).toContain("conversion_status = 'unsupported'");
});

it("reconvertSource resets a failed/unsupported row to pending", async () => {
  const query = vi.fn().mockResolvedValueOnce([{ affectedRows: 1 }, []]);
  const repo = new ComposeRepository({ query, getConnection: vi.fn() } as never);
  await repo.reconvertSource(9);
  const sql = String(query.mock.calls[0][0]);
  expect(sql).toContain("conversion_status = 'pending'");
  expect(sql).toContain("IN ('failed','unsupported')");
});
```

- [ ] **Step 2: Run; verify FAIL** (methods/columns missing)

Run: `npx vitest run src/spec-factory/compose-database.test.ts`

- [ ] **Step 3: Implement**

In `src/spec-factory/compose-database.ts`:

(a) Add a `SourceRow` interface near `SessionRow`:

```ts
interface SourceRow extends mysql.RowDataPacket {
  id: number;
  session_id: number;
  kind: ComposeSessionSourceSummary["kind"];
  original_filename: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  source_url: string | null;
  s3_key_raw: string | null;
  converter: ComposeSessionSourceSummary["converter"];
  markdown_path: string | null;
  markdown_content: string | null;
  conversion_status: ComposeSessionSourceSummary["conversionStatus"];
  error_message: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}
```

Import the type at the top (extend the existing import from `./compose-types.js`):

```ts
import type {
  ComposeSessionMessageSummary,
  ComposeSessionSourceSummary,
  ComposeSessionSummary,
} from "./compose-types.js";
```

(b) Add a `mapSource` helper near `mapSession`:

```ts
  private mapSource(row: SourceRow): ComposeSessionSourceSummary {
    return {
      id: row.id,
      sessionId: row.session_id,
      kind: row.kind,
      originalFilename: row.original_filename,
      mimeType: row.mime_type,
      sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
      sourceUrl: row.source_url,
      s3KeyRaw: row.s3_key_raw,
      converter: row.converter,
      markdownPath: row.markdown_path,
      markdownContent: row.markdown_content,
      conversionStatus: row.conversion_status,
      errorMessage: row.error_message,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  }
```

(c) **Replace** `addNoteSource` (delete the second message INSERT — store content directly):

```ts
  async addNoteSource(input: {
    sessionId: number;
    filename: string;
    content: string;
  }): Promise<number> {
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `INSERT INTO compose_session_sources
       (session_id, kind, original_filename, converter, conversion_status, markdown_content)
       VALUES (?, 'note', ?, 'none', 'converted', ?)`,
      [input.sessionId, input.filename, input.content],
    );
    return result.insertId;
  }
```

(d) **Replace** `listSessionSourceContents` (delete the LIKE-join + the Phase-1 comment block above it):

```ts
  async listSessionSourceContents(
    sessionId: number,
  ): Promise<ComposeEvidenceSourceInput[]> {
    const [rows] = await this.pool.query<
      Array<mysql.RowDataPacket & { original_filename: string | null; markdown_content: string | null }>
    >(
      `SELECT original_filename, markdown_content
       FROM compose_session_sources
       WHERE session_id = ?
         AND conversion_status = 'converted'
       ORDER BY id ASC`,
      [sessionId],
    );
    return rows.map((row) => ({
      filename: row.original_filename ?? "source.md",
      content: row.markdown_content ?? "",
    }));
  }
```

(e) Add the upload + conversion methods:

```ts
  async createUploadSource(input: {
    sessionId: number;
    filename: string;
    mimeType: string | null;
    sizeBytes: number | null;
    s3KeyRaw: string;
    converter: ComposeSessionSourceSummary["converter"];
  }): Promise<number> {
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `INSERT INTO compose_session_sources
       (session_id, kind, original_filename, mime_type, size_bytes, s3_key_raw, converter, conversion_status)
       VALUES (?, 'file', ?, ?, ?, ?, ?, 'pending')`,
      [
        input.sessionId,
        input.filename,
        input.mimeType,
        input.sizeBytes,
        input.s3KeyRaw,
        input.converter,
      ],
    );
    return result.insertId;
  }

  async createYoutubeSource(input: {
    sessionId: number;
    url: string;
  }): Promise<number> {
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `INSERT INTO compose_session_sources
       (session_id, kind, original_filename, source_url, converter, conversion_status)
       VALUES (?, 'youtube', ?, ?, 'markitdown', 'pending')`,
      [input.sessionId, input.url, input.url],
    );
    return result.insertId;
  }

  async updateSourceS3Key(input: {
    sourceId: number;
    s3KeyRaw: string;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE compose_session_sources SET s3_key_raw = ? WHERE id = ?`,
      [input.s3KeyRaw, input.sourceId],
    );
  }

  async getSessionSource(
    sourceId: number,
  ): Promise<ComposeSessionSourceSummary | null> {
    const [rows] = await this.pool.query<SourceRow[]>(
      `SELECT id, session_id, kind, original_filename, mime_type, size_bytes,
              source_url, s3_key_raw, converter, markdown_path, markdown_content,
              conversion_status, error_message, created_at, updated_at
       FROM compose_session_sources WHERE id = ? LIMIT 1`,
      [sourceId],
    );
    return rows[0] ? this.mapSource(rows[0]) : null;
  }

  async listSessionSources(
    sessionId: number,
  ): Promise<ComposeSessionSourceSummary[]> {
    const [rows] = await this.pool.query<SourceRow[]>(
      `SELECT id, session_id, kind, original_filename, mime_type, size_bytes,
              source_url, s3_key_raw, converter, markdown_path, markdown_content,
              conversion_status, error_message, created_at, updated_at
       FROM compose_session_sources WHERE session_id = ? ORDER BY id ASC`,
      [sessionId],
    );
    return rows.map((row) => this.mapSource(row));
  }

  async claimNextPendingSource(): Promise<ComposeSessionSourceSummary | null> {
    const [pending] = await this.pool.query<
      Array<mysql.RowDataPacket & { id: number; session_id: number }>
    >(
      `SELECT id, session_id
       FROM compose_session_sources
       WHERE conversion_status = 'pending'
       ORDER BY id ASC
       LIMIT 1`,
    );
    const row = pending[0];
    if (!row) return null;

    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `UPDATE compose_session_sources
       SET conversion_status = 'converting'
       WHERE id = ? AND conversion_status = 'pending'`,
      [row.id],
    );
    if (result.affectedRows !== 1) return null; // lost the race; caller loops again

    return this.getSessionSource(row.id);
  }

  async markSourceConverted(input: {
    sourceId: number;
    markdownPath: string | null;
    markdownContent: string;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE compose_session_sources
       SET conversion_status = 'converted',
           markdown_path = ?,
           markdown_content = ?,
           error_message = NULL
       WHERE id = ?`,
      [input.markdownPath, input.markdownContent, input.sourceId],
    );
  }

  async markSourceFailed(input: {
    sourceId: number;
    errorMessage: string;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE compose_session_sources
       SET conversion_status = 'failed', error_message = ?
       WHERE id = ?`,
      [input.errorMessage, input.sourceId],
    );
  }

  async markSourceUnsupported(input: {
    sourceId: number;
    errorMessage: string;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE compose_session_sources
       SET conversion_status = 'unsupported', error_message = ?
       WHERE id = ?`,
      [input.errorMessage, input.sourceId],
    );
  }

  async reconvertSource(sourceId: number): Promise<void> {
    await this.pool.query(
      `UPDATE compose_session_sources
       SET conversion_status = 'pending', error_message = NULL
       WHERE id = ? AND conversion_status IN ('failed','unsupported')`,
      [sourceId],
    );
  }
```

> Note: `SourceContentRow` (declared in Phase 1) is no longer used by `listSessionSourceContents` — if it has no other references, delete the interface to avoid a dead type. Check with `grep -n "SourceContentRow" src/spec-factory/compose-database.ts` and remove if unused.

- [ ] **Step 4: Run; verify PASS**

Run: `npx vitest run src/spec-factory/compose-database.test.ts`

- [ ] **Step 5: Typecheck**

Run: `npm run build`
Expected: clean. (The Phase-1 `compose-evidence-provider` uses `listSessionSourceContents` — its signature is unchanged, so it still compiles.)

- [ ] **Step 6: Commit**

```bash
git add src/spec-factory/compose-database.ts src/spec-factory/compose-database.test.ts
git commit -m "feat(compose): store markdown_content; add upload + conversion-claim repo methods"
```

---

## Task 4: markitdown sidecar (Python FastAPI)

**Files:**
- Create: `sidecar/markitdown/app.py`
- Create: `sidecar/markitdown/requirements.txt`
- Create: `sidecar/markitdown/test_app.py`
- Create: `Dockerfile.compose-markitdown`

- [ ] **Step 1: Write the failing test**

Create `sidecar/markitdown/requirements.txt`:

```
fastapi==0.115.6
uvicorn[standard]==0.34.0
markitdown[all]==0.1.6
python-multipart==0.0.20
httpx==0.28.1
pytest==8.3.4
```

> Version note: `markitdown[all]==0.1.6` is the current PyPI release (verified). Its API is `MarkItDown().convert(path_or_url).text_content`, which `app.py` below uses. If `0.1.6` is unavailable at build time, pin to the latest `0.1.x` and keep the same API call. The `[all]` extra pulls the optional converters (PDF, docx, pptx, xlsx, audio-metadata, youtube-transcript, etc.).

Create `sidecar/markitdown/test_app.py`:

```python
from fastapi.testclient import TestClient
from app import app

client = TestClient(app)


def test_health():
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json()["status"] == "ok"


def test_convert_plaintext_returns_markdown():
    files = {"file": ("notes.txt", b"Hello world", "text/plain")}
    res = client.post("/convert", files=files)
    assert res.status_code == 200
    body = res.json()
    assert "markdown" in body
    assert "Hello world" in body["markdown"]


def test_convert_missing_input_is_400():
    res = client.post("/convert")
    assert res.status_code == 400
```

- [ ] **Step 2: Run; verify FAIL** (no `app.py`)

Run: `cd sidecar/markitdown && python -m pytest test_app.py -q` (expects ImportError / collection error). If python deps aren't installed locally, note that and proceed — CI/docker will run them; still write the code to satisfy these tests.

- [ ] **Step 3: Implement the sidecar**

Create `sidecar/markitdown/app.py`:

```python
import os
import tempfile
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from markitdown import MarkItDown

app = FastAPI(title="compose-markitdown")
_md = MarkItDown()

MAX_BYTES = int(os.environ.get("MARKITDOWN_MAX_BYTES", str(50 * 1024 * 1024)))


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/convert")
async def convert(
    file: Optional[UploadFile] = File(default=None),
    url: Optional[str] = Form(default=None),
    filename: Optional[str] = Form(default=None),
):
    if file is None and not url:
        raise HTTPException(status_code=400, detail="Provide a file or a url")

    try:
        if url:
            result = _md.convert(url)
            return {"markdown": result.text_content or ""}

        data = await file.read()
        if len(data) > MAX_BYTES:
            raise HTTPException(status_code=413, detail="File too large")

        suffix = ""
        name = filename or file.filename or ""
        if "." in name:
            suffix = "." + name.rsplit(".", 1)[1]

        with tempfile.NamedTemporaryFile(suffix=suffix, delete=True) as tmp:
            tmp.write(data)
            tmp.flush()
            result = _md.convert(tmp.name)
        return {"markdown": result.text_content or ""}
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 — surface conversion failures as 422
        raise HTTPException(status_code=422, detail=f"Conversion failed: {exc}") from exc
```

Create `Dockerfile.compose-markitdown`:

```dockerfile
FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY sidecar/markitdown/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY sidecar/markitdown/app.py ./app.py

ENV MARKITDOWN_PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8080/health').status==200 else 1)"

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080"]
```

- [ ] **Step 4: Run; verify PASS** (if python env available)

Run: `cd sidecar/markitdown && pip install -r requirements.txt -q && python -m pytest test_app.py -q`
Expected: 3 passed. If the local environment cannot install Python deps, build the image to verify instead: `docker build -f Dockerfile.compose-markitdown -t compose-markitdown:test .` and report the build result; the pytest will run in CI (Task 9).

- [ ] **Step 5: Commit**

```bash
git add sidecar/markitdown Dockerfile.compose-markitdown
git commit -m "feat(compose): add markitdown FastAPI sidecar + Dockerfile"
```

---

## Task 5: markitdown HTTP client (Node)

**Files:**
- Create: `src/spec-factory/compose-markitdown-client.ts`
- Test: `src/spec-factory/compose-markitdown-client.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/spec-factory/compose-markitdown-client.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { MarkitdownClient } from "./compose-markitdown-client.js";

describe("MarkitdownClient", () => {
  it("convertFile POSTs multipart and returns markdown", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ markdown: "# Hello" }),
    });
    const client = new MarkitdownClient("http://localhost:8080", fetchMock as never);
    const md = await client.convertFile({
      bytes: Buffer.from("hi"),
      filename: "a.txt",
      mimeType: "text/plain",
    });
    expect(md).toBe("# Hello");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:8080/convert");
    expect(init.method).toBe("POST");
  });

  it("convertUrl POSTs the url form field", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ markdown: "transcript" }),
    });
    const client = new MarkitdownClient("http://localhost:8080", fetchMock as never);
    const md = await client.convertUrl("https://youtu.be/x");
    expect(md).toBe("transcript");
  });

  it("throws with the sidecar status + detail on non-OK", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({ detail: "Conversion failed: bad zip" }),
    });
    const client = new MarkitdownClient("http://localhost:8080", fetchMock as never);
    await expect(client.convertUrl("https://x")).rejects.toThrow(/422.*Conversion failed/);
  });
});
```

- [ ] **Step 2: Run; verify FAIL**

Run: `npx vitest run src/spec-factory/compose-markitdown-client.test.ts`

- [ ] **Step 3: Implement**

Create `src/spec-factory/compose-markitdown-client.ts`:

```ts
type FetchFn = typeof fetch;

export class MarkitdownClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  async convertFile(input: {
    bytes: Buffer;
    filename: string;
    mimeType: string | null;
  }): Promise<string> {
    const form = new FormData();
    const blob = new Blob([input.bytes], {
      type: input.mimeType ?? "application/octet-stream",
    });
    form.append("file", blob, input.filename);
    form.append("filename", input.filename);
    return this.post(form);
  }

  async convertUrl(url: string): Promise<string> {
    const form = new FormData();
    form.append("url", url);
    return this.post(form);
  }

  private async post(form: FormData): Promise<string> {
    const response = await this.fetchFn(`${this.baseUrl}/convert`, {
      method: "POST",
      body: form,
    });
    if (!response.ok) {
      let detail = "";
      try {
        const body = (await response.json()) as { detail?: string };
        detail = body?.detail ? `: ${body.detail}` : "";
      } catch {
        detail = "";
      }
      throw new Error(`markitdown convert failed (${response.status})${detail}`);
    }
    const body = (await response.json()) as { markdown?: string };
    return body.markdown ?? "";
  }
}
```

- [ ] **Step 4: Run; verify PASS**

Run: `npx vitest run src/spec-factory/compose-markitdown-client.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/spec-factory/compose-markitdown-client.ts src/spec-factory/compose-markitdown-client.test.ts
git commit -m "feat(compose): add markitdown HTTP client"
```

---

## Task 6: Presigned uploads helper

**Files:**
- Create: `src/spec-factory/compose-uploads.ts`
- Test: `src/spec-factory/compose-uploads.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/spec-factory/compose-uploads.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { composeRawKey, safeUploadFilename, ComposeUploads } from "./compose-uploads.js";

describe("compose-uploads helpers", () => {
  it("safeUploadFilename strips path + unsafe chars", () => {
    expect(safeUploadFilename("../../etc/passwd")).toBe("passwd");
    expect(safeUploadFilename("My Spec (v2).pdf")).toBe("My_Spec__v2_.pdf");
    expect(safeUploadFilename("")).toBe("upload");
  });

  it("composeRawKey builds the per-session raw key", () => {
    expect(composeRawKey("compose/4/", 21, "spec.pdf")).toBe("compose/4/raw/21-spec.pdf");
  });

  it("createUploadUrl returns a presigned PUT url + key", async () => {
    const signer = vi.fn().mockResolvedValue("https://s3.example/put?sig=abc");
    const uploads = new ComposeUploads({
      bucket: "specter-results",
      presign: signer as never,
    });
    const target = await uploads.createUploadUrl({
      s3Prefix: "compose/4/",
      sourceId: 21,
      filename: "spec.pdf",
      mimeType: "application/pdf",
    });
    expect(target.uploadUrl).toContain("https://s3.example/put");
    expect(target.s3KeyRaw).toBe("compose/4/raw/21-spec.pdf");
    expect(target.sourceId).toBe(21);
    expect(target.expiresInSeconds).toBe(900);
  });
});
```

- [ ] **Step 2: Run; verify FAIL**

Run: `npx vitest run src/spec-factory/compose-uploads.test.ts`

- [ ] **Step 3: Implement**

Create `src/spec-factory/compose-uploads.ts`:

```ts
import { PutObjectCommand, GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createS3Client } from "../utils/awsClients.js";
import type { ComposeUploadTarget } from "./compose-types.js";

const DEFAULT_EXPIRES_SECONDS = 900;

export function safeUploadFilename(filename: string): string {
  const basename = (filename.split(/[\\/]/).pop() ?? "").replace(
    /[^A-Za-z0-9._-]+/g,
    "_",
  );
  return basename || "upload";
}

export function composeRawKey(
  s3Prefix: string,
  sourceId: number,
  filename: string,
): string {
  const prefix = s3Prefix.endsWith("/") ? s3Prefix : `${s3Prefix}/`;
  return `${prefix}raw/${sourceId}-${safeUploadFilename(filename)}`;
}

type Presigner = (
  client: S3Client,
  command: PutObjectCommand | GetObjectCommand,
  options: { expiresIn: number },
) => Promise<string>;

export class ComposeUploads {
  private readonly bucket: string;
  private readonly client: S3Client;
  private readonly presign: Presigner;

  constructor(options?: {
    bucket?: string;
    client?: S3Client;
    presign?: Presigner;
  }) {
    this.bucket =
      options?.bucket ??
      process.env.SPEC_FACTORY_ATTACHMENT_BUCKET?.trim() ??
      `${process.env.S3_BUCKET_PREFIX || "specter"}-results`;
    this.client = options?.client ?? createS3Client();
    this.presign = options?.presign ?? (getSignedUrl as unknown as Presigner);
  }

  async createUploadUrl(input: {
    s3Prefix: string;
    sourceId: number;
    filename: string;
    mimeType: string | null;
  }): Promise<ComposeUploadTarget> {
    const s3KeyRaw = composeRawKey(input.s3Prefix, input.sourceId, input.filename);
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: s3KeyRaw,
      ContentType: input.mimeType ?? "application/octet-stream",
    });
    const uploadUrl = await this.presign(this.client, command, {
      expiresIn: DEFAULT_EXPIRES_SECONDS,
    });
    return {
      sourceId: input.sourceId,
      uploadUrl,
      s3KeyRaw,
      expiresInSeconds: DEFAULT_EXPIRES_SECONDS,
    };
  }

  async fetchRawObject(s3KeyRaw: string): Promise<Buffer> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: s3KeyRaw }),
    );
    const body = response.Body as unknown as {
      transformToByteArray: () => Promise<Uint8Array>;
    };
    const bytes = await body.transformToByteArray();
    return Buffer.from(bytes);
  }
}
```

- [ ] **Step 4: Run; verify PASS**

Run: `npx vitest run src/spec-factory/compose-uploads.test.ts`

- [ ] **Step 5: Typecheck + commit**

Run: `npm run build` (expect clean).

```bash
git add src/spec-factory/compose-uploads.ts src/spec-factory/compose-uploads.test.ts
git commit -m "feat(compose): add presigned upload helper"
```

---

## Task 7: Conversion worker

**Files:**
- Create: `src/spec-factory/compose-conversion.ts`
- Test: `src/spec-factory/compose-conversion.test.ts`

The worker drains `pending` sources: claim → fetch raw (or use URL) → route → convert → write `.md` to the workspace + DB → mark converted/failed/unsupported.

- [ ] **Step 1: Write the failing test**

Create `src/spec-factory/compose-conversion.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { ComposeConversionWorker, audioMimeOrExt } from "./compose-conversion.js";

function source(overrides = {}) {
  return {
    id: 7,
    sessionId: 4,
    kind: "file",
    originalFilename: "spec.pdf",
    mimeType: "application/pdf",
    sizeBytes: 10,
    sourceUrl: null,
    s3KeyRaw: "compose/4/raw/7-spec.pdf",
    converter: "markitdown",
    markdownPath: null,
    markdownContent: null,
    conversionStatus: "converting",
    errorMessage: null,
    createdAt: "x",
    updatedAt: "x",
    ...overrides,
  };
}

function buildWorker(over: { claim?: any } = {}) {
  const repo = {
    claimNextPendingSource: vi.fn(),
    getSession: vi.fn().mockResolvedValue({ id: 4, workspacePath: "/w/4" }),
    markSourceConverted: vi.fn().mockResolvedValue(undefined),
    markSourceFailed: vi.fn().mockResolvedValue(undefined),
    markSourceUnsupported: vi.fn().mockResolvedValue(undefined),
  };
  const uploads = { fetchRawObject: vi.fn().mockResolvedValue(Buffer.from("raw")) };
  const markitdown = {
    convertFile: vi.fn().mockResolvedValue("# Converted"),
    convertUrl: vi.fn().mockResolvedValue("transcript"),
  };
  const fsWriter = { writeMarkdown: vi.fn().mockResolvedValue("/w/4/sources/7-spec.pdf.md") };
  const worker = new ComposeConversionWorker(
    repo as never,
    uploads as never,
    markitdown as never,
    { fsWriter: fsWriter as never },
  );
  return { worker, repo, uploads, markitdown, fsWriter };
}

describe("ComposeConversionWorker", () => {
  it("audioMimeOrExt detects audio", () => {
    expect(audioMimeOrExt("audio/mpeg", "x.mp3")).toBe(true);
    expect(audioMimeOrExt(null, "clip.wav")).toBe(true);
    expect(audioMimeOrExt("application/pdf", "x.pdf")).toBe(false);
  });

  it("converts a file source via markitdown and marks converted", async () => {
    const { worker, repo, uploads, markitdown, fsWriter } = buildWorker();
    await worker.convertOne(source() as never);
    expect(uploads.fetchRawObject).toHaveBeenCalledWith("compose/4/raw/7-spec.pdf");
    expect(markitdown.convertFile).toHaveBeenCalled();
    expect(fsWriter.writeMarkdown).toHaveBeenCalled();
    expect(repo.markSourceConverted).toHaveBeenCalledWith({
      sourceId: 7,
      markdownPath: "/w/4/sources/7-spec.pdf.md",
      markdownContent: "# Converted",
    });
  });

  it("converts a youtube source via convertUrl", async () => {
    const { worker, markitdown, repo } = buildWorker();
    await worker.convertOne(
      source({ kind: "youtube", sourceUrl: "https://youtu.be/x", s3KeyRaw: null, originalFilename: "https://youtu.be/x" }) as never,
    );
    expect(markitdown.convertUrl).toHaveBeenCalledWith("https://youtu.be/x");
    expect(repo.markSourceConverted).toHaveBeenCalled();
  });

  it("marks audio sources unsupported (Phase 2 defers voxtral)", async () => {
    const { worker, repo, markitdown } = buildWorker();
    await worker.convertOne(source({ mimeType: "audio/mpeg", originalFilename: "clip.mp3" }) as never);
    expect(markitdown.convertFile).not.toHaveBeenCalled();
    expect(repo.markSourceUnsupported).toHaveBeenCalledWith({
      sourceId: 7,
      errorMessage: expect.stringMatching(/audio/i),
    });
  });

  it("marks failed when markitdown throws", async () => {
    const { worker, repo, markitdown } = buildWorker();
    markitdown.convertFile.mockRejectedValueOnce(new Error("bad pdf"));
    await worker.convertOne(source() as never);
    expect(repo.markSourceFailed).toHaveBeenCalledWith({
      sourceId: 7,
      errorMessage: expect.stringContaining("bad pdf"),
    });
  });

  it("drain() claims until none remain", async () => {
    const { worker, repo } = buildWorker();
    repo.claimNextPendingSource
      .mockResolvedValueOnce(source({ id: 1 }))
      .mockResolvedValueOnce(null);
    const spy = vi.spyOn(worker, "convertOne").mockResolvedValue(undefined);
    await worker.drain();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run; verify FAIL**

Run: `npx vitest run src/spec-factory/compose-conversion.test.ts`

- [ ] **Step 3: Implement**

Create `src/spec-factory/compose-conversion.ts`:

```ts
import { promises as fs } from "fs";
import path from "path";
import type { ComposeRepository } from "./compose-database.js";
import type { ComposeUploads } from "./compose-uploads.js";
import type { MarkitdownClient } from "./compose-markitdown-client.js";
import type { ComposeSessionSourceSummary } from "./compose-types.js";

const AUDIO_EXTS = [".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".webm"];

export function audioMimeOrExt(
  mimeType: string | null,
  filename: string | null,
): boolean {
  if (mimeType && mimeType.toLowerCase().startsWith("audio/")) return true;
  const name = (filename ?? "").toLowerCase();
  return AUDIO_EXTS.some((ext) => name.endsWith(ext));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ConversionRepo {
  claimNextPendingSource(): Promise<ComposeSessionSourceSummary | null>;
  getSession(sessionId: number): Promise<{ workspacePath: string } | null>;
  markSourceConverted(input: {
    sourceId: number;
    markdownPath: string | null;
    markdownContent: string;
  }): Promise<void>;
  markSourceFailed(input: { sourceId: number; errorMessage: string }): Promise<void>;
  markSourceUnsupported(input: {
    sourceId: number;
    errorMessage: string;
  }): Promise<void>;
}

interface FsWriter {
  writeMarkdown(input: {
    workspacePath: string;
    sourceId: number;
    filename: string;
    markdown: string;
  }): Promise<string>;
}

const defaultFsWriter: FsWriter = {
  async writeMarkdown({ workspacePath, sourceId, filename, markdown }) {
    const dir = path.join(workspacePath, "sources");
    await fs.mkdir(dir, { recursive: true });
    const safe = (filename.split(/[\\/]/).pop() ?? "source").replace(
      /[^A-Za-z0-9._-]+/g,
      "_",
    );
    const outPath = path.join(dir, `${sourceId}-${safe}.md`);
    await fs.writeFile(outPath, markdown, "utf8");
    return outPath;
  },
};

export class ComposeConversionWorker {
  private readonly fsWriter: FsWriter;
  private running = false;

  constructor(
    private readonly repository: ConversionRepo &
      Pick<ComposeRepository, "claimNextPendingSource">,
    private readonly uploads: Pick<ComposeUploads, "fetchRawObject">,
    private readonly markitdown: Pick<
      MarkitdownClient,
      "convertFile" | "convertUrl"
    >,
    options: { fsWriter?: FsWriter } = {},
  ) {
    this.fsWriter = options.fsWriter ?? defaultFsWriter;
  }

  /** Non-reentrant drain of all pending sources. */
  async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (true) {
        const source = await this.repository.claimNextPendingSource();
        if (!source) return;
        await this.convertOne(source);
      }
    } finally {
      this.running = false;
    }
  }

  async convertOne(source: ComposeSessionSourceSummary): Promise<void> {
    try {
      if (audioMimeOrExt(source.mimeType, source.originalFilename)) {
        await this.repository.markSourceUnsupported({
          sourceId: source.id,
          errorMessage:
            "Audio transcription is not available yet (planned for a later phase).",
        });
        return;
      }

      let markdown: string;
      if (source.kind === "youtube" && source.sourceUrl) {
        markdown = await this.markitdown.convertUrl(source.sourceUrl);
      } else if (source.s3KeyRaw) {
        const bytes = await this.uploads.fetchRawObject(source.s3KeyRaw);
        markdown = await this.markitdown.convertFile({
          bytes,
          filename: source.originalFilename ?? "source",
          mimeType: source.mimeType,
        });
      } else {
        await this.repository.markSourceFailed({
          sourceId: source.id,
          errorMessage: "Source has neither an uploaded object nor a URL",
        });
        return;
      }

      const session = await this.repository.getSession(source.sessionId);
      let markdownPath: string | null = null;
      if (session?.workspacePath) {
        markdownPath = await this.fsWriter.writeMarkdown({
          workspacePath: session.workspacePath,
          sourceId: source.id,
          filename: source.originalFilename ?? "source",
          markdown,
        });
      }

      await this.repository.markSourceConverted({
        sourceId: source.id,
        markdownPath,
        markdownContent: markdown,
      });
    } catch (error) {
      await this.repository.markSourceFailed({
        sourceId: source.id,
        errorMessage: errorMessage(error),
      });
    }
  }
}
```

> Note: `getSession` returns `ComposeSessionSummary | null`, which structurally satisfies `{ workspacePath: string } | null`. The `ConversionRepo.getSession` type above narrows to what the worker uses.

- [ ] **Step 4: Run; verify PASS**

Run: `npx vitest run src/spec-factory/compose-conversion.test.ts`

- [ ] **Step 5: Typecheck + commit**

Run: `npm run build` (expect clean).

```bash
git add src/spec-factory/compose-conversion.ts src/spec-factory/compose-conversion.test.ts
git commit -m "feat(compose): add conversion worker (claim -> convert -> persist)"
```

---

## Task 8: Service + routes + server wiring

**Files:**
- Modify: `src/spec-factory/compose-service.ts`
- Modify: `src/spec-factory/compose-service.test.ts`
- Modify: `src/spec-factory/compose-routes.ts`
- Modify: `src/spec-factory/compose-routes.test.ts`
- Modify: `src/spec-factory/server.ts`

- [ ] **Step 1: Write the failing service tests**

Add to `src/spec-factory/compose-service.test.ts`. First extend `buildService()` mocks with the new collaborators (read the existing helper and add): `composeRepository.createUploadSource`, `createYoutubeSource`, `updateSourceS3Key`, `getSessionSource`, `listSessionSources`, `reconvertSource`; an `uploads = { createUploadUrl: vi.fn() }`; a `conversionWorker = { drain: vi.fn().mockResolvedValue(undefined) }`. Update the `new ComposeService(...)` construction to pass them (see Step 3 for the constructor shape). Then:

```ts
it("requestUpload mints a pending source and returns a presigned target", async () => {
  const { service, composeRepository, uploads } = buildService();
  composeRepository.createUploadSource.mockResolvedValue(21);
  uploads.createUploadUrl.mockResolvedValue({
    sourceId: 21, uploadUrl: "https://s3/put", s3KeyRaw: "compose/7/raw/21-spec.pdf", expiresInSeconds: 900,
  });
  const target = await service.requestUpload({
    sessionId: 7, filename: "spec.pdf", mimeType: "application/pdf", sizeBytes: 2048,
  });
  expect(target.uploadUrl).toBe("https://s3/put");
  expect(composeRepository.createUploadSource).toHaveBeenCalled();
});

it("confirmUpload kicks the conversion worker", async () => {
  const { service, conversionWorker } = buildService();
  await service.confirmUpload({ sessionId: 7, sourceId: 21 });
  expect(conversionWorker.drain).toHaveBeenCalled();
});

it("addYoutube mints a youtube source and kicks the worker", async () => {
  const { service, composeRepository, conversionWorker } = buildService();
  composeRepository.createYoutubeSource.mockResolvedValue(22);
  await service.addYoutube({ sessionId: 7, url: "https://youtu.be/x" });
  expect(composeRepository.createYoutubeSource).toHaveBeenCalledWith({ sessionId: 7, url: "https://youtu.be/x" });
  expect(conversionWorker.drain).toHaveBeenCalled();
});

it("addYoutube rejects a blank url", async () => {
  const { service } = buildService();
  await expect(service.addYoutube({ sessionId: 7, url: "  " })).rejects.toThrow(/url/i);
});

it("listSources returns the session's sources", async () => {
  const { service, composeRepository } = buildService();
  composeRepository.listSessionSources.mockResolvedValue([]);
  expect(await service.listSources(7)).toEqual([]);
});

it("reconvert resets a source and kicks the worker", async () => {
  const { service, composeRepository, conversionWorker } = buildService();
  await service.reconvert({ sessionId: 7, sourceId: 21 });
  expect(composeRepository.reconvertSource).toHaveBeenCalledWith(21);
  expect(conversionWorker.drain).toHaveBeenCalled();
});
```

Also update the existing `addNote` test if it asserted the old two-query behavior — the note path is unchanged at the service layer (still `addNoteSource`), so it should still pass.

- [ ] **Step 2: Run; verify FAIL**

Run: `npx vitest run src/spec-factory/compose-service.test.ts`

- [ ] **Step 3: Implement the service**

In `src/spec-factory/compose-service.ts`:

(a) Widen the repo Pick and add collaborators. Update `ComposeServiceComposeRepo`:

```ts
type ComposeServiceComposeRepo = Pick<
  ComposeRepository,
  | "createSession"
  | "updateSessionPaths"
  | "getSession"
  | "listSessions"
  | "addNoteSource"
  | "linkSource"
  | "createUploadSource"
  | "createYoutubeSource"
  | "getSessionSource"
  | "listSessionSources"
  | "reconvertSource"
>;
```

(b) Add collaborator types + constructor params:

```ts
interface UploadIssuer {
  createUploadUrl(input: {
    s3Prefix: string;
    sourceId: number;
    filename: string;
    mimeType: string | null;
  }): Promise<import("./compose-types.js").ComposeUploadTarget>;
}

interface ConversionKicker {
  drain(): Promise<void>;
}
```

Add `uploads: UploadIssuer` and `conversionWorker: ConversionKicker` as constructor params (after `draftRequester`, before `config`), store them. Update the test's `new ComposeService(...)` call to match this exact parameter order: `(composeRepository, specRepository, draftRequester, uploads, conversionWorker, config)`.

(c) Add methods:

```ts
  async requestUpload(input: {
    sessionId: number;
    filename: string;
    mimeType: string | null;
    sizeBytes: number | null;
  }): Promise<import("./compose-types.js").ComposeUploadTarget> {
    const filename = input.filename.trim();
    if (!filename) throw new Error("Upload filename is required");
    const session = requireSession(
      await this.composeRepository.getSession(input.sessionId),
      input.sessionId,
    );
    const sourceId = await this.composeRepository.createUploadSource({
      sessionId: input.sessionId,
      filename,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      s3KeyRaw: "", // set after we know the id, below
      converter: "markitdown",
    });
    const target = await this.uploads.createUploadUrl({
      s3Prefix: session.s3Prefix,
      sourceId,
      filename,
      mimeType: input.mimeType,
    });
    await this.composeRepository.updateSourceS3Key({
      sourceId,
      s3KeyRaw: target.s3KeyRaw,
    });
    return target;
  }

  async confirmUpload(input: {
    sessionId: number;
    sourceId: number;
  }): Promise<void> {
    // Source is already 'pending' from createUploadSource; just trigger conversion.
    void input.sessionId;
    void input.sourceId;
    await this.conversionWorker.drain();
  }

  async addYoutube(input: { sessionId: number; url: string }): Promise<void> {
    const url = input.url.trim();
    if (!url) throw new Error("YouTube url is required");
    await this.composeRepository.createYoutubeSource({
      sessionId: input.sessionId,
      url,
    });
    await this.conversionWorker.drain();
  }

  async listSources(sessionId: number) {
    return this.composeRepository.listSessionSources(sessionId);
  }

  async reconvert(input: {
    sessionId: number;
    sourceId: number;
  }): Promise<void> {
    void input.sessionId;
    await this.composeRepository.reconvertSource(input.sourceId);
    await this.conversionWorker.drain();
  }
```

> Note: `requestUpload` needs `updateSourceS3Key` on the repo Pick — add `| "updateSourceS3Key"` to `ComposeServiceComposeRepo`. Also keep `addNote` unchanged.

- [ ] **Step 4: Implement the routes**

In `src/spec-factory/compose-routes.ts`, widen `ComposeRouteService`:

```ts
type ComposeRouteService = Pick<
  ComposeService,
  | "createSession"
  | "listSessions"
  | "getSession"
  | "addNote"
  | "handoff"
  | "requestUpload"
  | "confirmUpload"
  | "addYoutube"
  | "listSources"
  | "reconvert"
>;
```

Add routes (using the existing `positiveInt`, `handleError`, `optionalString`):

```ts
  router.get("/sessions/:sessionId/sources", async (req, res) => {
    try {
      const sessionId = positiveInt(req.params.sessionId, "sessionId");
      res.setHeader("Cache-Control", "no-cache");
      res.json(await service.listSources(sessionId));
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post("/sessions/:sessionId/uploads", async (req, res) => {
    try {
      const sessionId = positiveInt(req.params.sessionId, "sessionId");
      const filename =
        typeof req.body?.filename === "string" ? req.body.filename : "";
      const target = await service.requestUpload({
        sessionId,
        filename,
        mimeType: optionalString(req.body?.mimeType),
        sizeBytes:
          typeof req.body?.sizeBytes === "number" ? req.body.sizeBytes : null,
      });
      res.status(201).json(target);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post("/sessions/:sessionId/sources/:sourceId/uploaded", async (req, res) => {
    try {
      const sessionId = positiveInt(req.params.sessionId, "sessionId");
      const sourceId = positiveInt(req.params.sourceId, "sourceId");
      await service.confirmUpload({ sessionId, sourceId });
      res.status(202).json({ accepted: true });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post("/sessions/:sessionId/youtube", async (req, res) => {
    try {
      const sessionId = positiveInt(req.params.sessionId, "sessionId");
      const url = typeof req.body?.url === "string" ? req.body.url : "";
      await service.addYoutube({ sessionId, url });
      res.status(202).json({ accepted: true });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post("/sessions/:sessionId/sources/:sourceId/reconvert", async (req, res) => {
    try {
      const sessionId = positiveInt(req.params.sessionId, "sessionId");
      const sourceId = positiveInt(req.params.sourceId, "sourceId");
      await service.reconvert({ sessionId, sourceId });
      res.status(202).json({ accepted: true });
    } catch (error) {
      handleError(res, error);
    }
  });
```

- [ ] **Step 5: Add route tests**

Add to `src/spec-factory/compose-routes.test.ts` (extend `makeService()` with `requestUpload`, `confirmUpload`, `addYoutube`, `listSources`, `reconvert` vi.fns), then:

```ts
it("POST /sessions/:id/uploads returns a presigned target (201)", async () => {
  const service = makeService();
  service.requestUpload.mockResolvedValue({ sourceId: 9, uploadUrl: "https://s3/put", s3KeyRaw: "k", expiresInSeconds: 900 });
  const ctx = await start(service); server = ctx.server;
  const res = await ctx.request("/api/spec-factory/compose/sessions/7/uploads", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename: "spec.pdf", mimeType: "application/pdf", sizeBytes: 10 }),
  });
  expect(res.status).toBe(201);
  expect(res.body.uploadUrl).toBe("https://s3/put");
});

it("POST /sessions/:id/sources/:sid/uploaded accepts (202)", async () => {
  const service = makeService();
  service.confirmUpload.mockResolvedValue(undefined);
  const ctx = await start(service); server = ctx.server;
  const res = await ctx.request("/api/spec-factory/compose/sessions/7/sources/9/uploaded", { method: "POST" });
  expect(res.status).toBe(202);
  expect(service.confirmUpload).toHaveBeenCalledWith({ sessionId: 7, sourceId: 9 });
});

it("POST /sessions/:id/youtube accepts (202)", async () => {
  const service = makeService();
  service.addYoutube.mockResolvedValue(undefined);
  const ctx = await start(service); server = ctx.server;
  const res = await ctx.request("/api/spec-factory/compose/sessions/7/youtube", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: "https://youtu.be/x" }),
  });
  expect(res.status).toBe(202);
});

it("GET /sessions/:id/sources lists (200)", async () => {
  const service = makeService();
  service.listSources.mockResolvedValue([]);
  const ctx = await start(service); server = ctx.server;
  const res = await ctx.request("/api/spec-factory/compose/sessions/7/sources");
  expect(res.status).toBe(200);
  expect(res.body).toEqual([]);
});
```

- [ ] **Step 6: Wire the server**

In `src/spec-factory/server.ts`:

(a) Add imports:

```ts
import { MarkitdownClient } from "./compose-markitdown-client.js";
import { ComposeUploads } from "./compose-uploads.js";
import { ComposeConversionWorker } from "./compose-conversion.js";
```

(b) After `composeEvidenceProvider` is constructed, add:

```ts
  const composeUploads = new ComposeUploads();
  const markitdownClient = new MarkitdownClient(
    process.env.COMPOSE_MARKITDOWN_URL?.trim() || "http://localhost:8080",
  );
  const composeConversionWorker = new ComposeConversionWorker(
    composeRepository,
    composeUploads,
    markitdownClient,
  );
```

(c) Update the `ComposeService` construction to the new signature:

```ts
  const composeService = new ComposeService(
    composeRepository,
    repository,
    service,
    composeUploads,
    composeConversionWorker,
    {
      workspaceBase:
        process.env.COMPOSE_WORKSPACE_BASE?.trim() ||
        "/mnt/efs/specter-repo/spec-factory/compose",
      s3Prefix: process.env.COMPOSE_S3_PREFIX?.trim() || "compose",
    },
  );
```

(d) Add a periodic drain so uploads that complete out-of-band still convert (belt-and-suspenders alongside the per-action `drain()`):

```ts
  setInterval(() => {
    void composeConversionWorker.drain().catch((error) => {
      console.warn(
        `[spec-factory] compose conversion drain failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }, Number(process.env.COMPOSE_CONVERSION_POLL_MS || 5000));
```

- [ ] **Step 7: Run all compose tests + build**

Run: `npx vitest run src/spec-factory/compose-service.test.ts src/spec-factory/compose-routes.test.ts`
Expected: all pass.
Run: `npm run build`
Expected: clean.

- [ ] **Step 8: Full spec-factory suite**

Run: `npx vitest run src/spec-factory/compose-types.test.ts src/spec-factory/compose-database.test.ts src/spec-factory/compose-evidence-provider.test.ts src/spec-factory/compose-service.test.ts src/spec-factory/compose-routes.test.ts src/spec-factory/compose-markitdown-client.test.ts src/spec-factory/compose-uploads.test.ts src/spec-factory/compose-conversion.test.ts src/spec-factory/service.test.ts src/spec-factory/database.test.ts src/spec-factory/evidence.test.ts`
Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add src/spec-factory/compose-service.ts src/spec-factory/compose-service.test.ts src/spec-factory/compose-routes.ts src/spec-factory/compose-routes.test.ts src/spec-factory/server.ts
git commit -m "feat(compose): upload/youtube/list/reconvert routes + conversion worker wiring"
```

---

## Task 9: Infra — sidecar container, CORS, env, CI

**Files:**
- Modify: `terraform/spec-factory-ecs.tf`
- Modify: `terraform/s3.tf`
- Modify: `terraform/variables.tf`
- Modify: `.github/workflows/spec-factory-build-push.yml`

> This task changes infra-as-code only; there is no unit test. Verification = `terraform validate` (if available) + `terraform fmt -check` + a `docker build` of the sidecar. If terraform tooling/creds are unavailable in the environment, make the edits, run `terraform fmt`, and report that `validate`/`plan` must be run by the operator with creds.

- [ ] **Step 1: Add the markitdown ECR repo + sidecar container to the task def**

In `terraform/spec-factory-ecs.tf`:

(a) Add an ECR repo for the sidecar near the existing `aws_ecr_repository.spec_factory`:

```hcl
resource "aws_ecr_repository" "compose_markitdown" {
  count                = var.enable_spec_factory ? 1 : 0
  name                 = "specter/compose-markitdown"
  image_tag_mutability = "MUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = merge(local.common_tags, { Service = "compose-markitdown" })
}
```

(b) Add a second container to the `container_definitions` jsonencode array (sibling of the `spec-factory` object). The `spec-factory` container already exists; append this object to the same array:

```hcl
    ,
    {
      name      = "compose-markitdown"
      image     = "${aws_ecr_repository.compose_markitdown[0].repository_url}:latest"
      essential = true

      portMappings = [{
        containerPort = 8080
        hostPort      = 8080
        protocol      = "tcp"
      }]

      healthCheck = {
        command     = ["CMD-SHELL", "python -c \"import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8080/health').status==200 else 1)\""]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 30
      }

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.spec_factory[0].name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "compose-markitdown"
        }
      }
    }
```

(c) Add the COMPOSE_* env vars to the **spec-factory** container's `environment` array (after the `SPEC_FACTORY_EVIDENCE_WORKSPACE_BASE` line):

```hcl
      { name = "COMPOSE_WORKSPACE_BASE", value = "/mnt/efs/specter-repo/spec-factory/compose" },
      { name = "COMPOSE_S3_PREFIX", value = "compose" },
      { name = "COMPOSE_MARKITDOWN_URL", value = "http://localhost:8080" },
```

(d) Add the markitdown ECR repo url to the outputs near the existing spec-factory ECR output:

```hcl
output "compose_markitdown_ecr_repository_url" {
  value       = var.enable_spec_factory ? aws_ecr_repository.compose_markitdown[0].repository_url : null
  description = "ECR repository URL for the compose markitdown sidecar"
}
```

- [ ] **Step 2: Add S3 CORS for presigned browser PUT**

In `terraform/s3.tf`, after the `aws_s3_bucket.results` resource and its existing configs, add:

```hcl
resource "aws_s3_bucket_cors_configuration" "results_compose" {
  bucket = aws_s3_bucket.results.id

  cors_rule {
    allowed_methods = ["PUT"]
    allowed_origins = var.compose_upload_allowed_origins
    allowed_headers = ["*"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }
}
```

In `terraform/variables.tf`, add:

```hcl
variable "compose_upload_allowed_origins" {
  type        = list(string)
  description = "Browser origins allowed to presigned-PUT Compose uploads to the results bucket"
  default     = ["*"]
}
```

> `default = ["*"]` keeps it unblocked; tighten to the dashboard origin in `shared.auto.tfvars` during deploy. Note this in the completion notes.

- [ ] **Step 3: CI — build + push the sidecar, run the sidecar pytest, add vitest files**

In `.github/workflows/spec-factory-build-push.yml`:

(a) Add the sidecar paths to the `paths:` triggers (both push and PR sections) alongside `Dockerfile.spec-factory`:

```yaml
      - 'Dockerfile.compose-markitdown'
      - 'sidecar/markitdown/**'
```

(b) In the test job, after the existing vitest invocation, add the new Phase-2 test files to whatever list/glob the workflow uses (it currently lists spec-factory test files explicitly — add `compose-markitdown-client.test.ts`, `compose-uploads.test.ts`, `compose-conversion.test.ts`). If it uses a glob like `src/spec-factory/*.test.ts`, no change needed — verify which.

(c) Add a sidecar build+push mirroring the existing spec-factory image steps. After the spec-factory "Build Docker image" / "Push Docker image to ECR" steps, add parallel steps:

```yaml
      - name: Build markitdown sidecar image
        run: |
          docker build -f Dockerfile.compose-markitdown -t "${COMPOSE_MARKITDOWN_ECR}:${{ github.sha }}" .

      - name: Push markitdown sidecar image to ECR
        run: |
          docker tag "${COMPOSE_MARKITDOWN_ECR}:${{ github.sha }}" "${COMPOSE_MARKITDOWN_ECR}:latest"
          docker push "${COMPOSE_MARKITDOWN_ECR}:${{ github.sha }}"
          docker push "${COMPOSE_MARKITDOWN_ECR}:latest"
```

Define `COMPOSE_MARKITDOWN_ECR` next to where `ECR_REPOSITORY` is defined (same registry, repo name `specter/compose-markitdown`). Match the existing repo-detect/login guards the spec-factory steps already use (so a fresh env without the ECR repo no-ops rather than failing).

- [ ] **Step 4: Verify**

Run: `terraform -chdir=terraform fmt` then `terraform -chdir=terraform validate` (if creds/backend available). If not available, run `terraform -chdir=terraform fmt -check` to confirm formatting and report that validate/plan is deferred to the operator.
Run: `docker build -f Dockerfile.compose-markitdown -t compose-markitdown:test .` (expect success).

- [ ] **Step 5: Commit**

```bash
git add terraform/spec-factory-ecs.tf terraform/s3.tf terraform/variables.tf .github/workflows/spec-factory-build-push.yml
git commit -m "feat(compose): ship markitdown sidecar container + S3 CORS + env + CI"
```

---

## Task 10: Phase-2 completion verification & notes

**Files:**
- Create: `docs/superpowers/plans/2026-06-02-compose-sessions-phase-2-COMPLETION.md`

- [ ] **Step 1: Build + full backend test run**

Run: `npm run build` (clean) and the full compose+touched suite from Task 8 Step 8 (all green). Record counts.

- [ ] **Step 2: Write completion notes**

Create the completion doc covering: what shipped, test/build results, the manual end-to-end verification path (below), the deploy steps (apply migration 038; `terraform apply` for the sidecar container + CORS + ECR repo; CI builds both images), and the Phase-2 → Phase-3 handoff.

Manual happy-path (requires migration 038, both images deployed, service on :3012, sidecar on :8080):

```
1. POST /compose/sessions { "name": "Audit upload" } -> 201 { id }
2. POST /compose/sessions/<id>/uploads { "filename":"spec.pdf","mimeType":"application/pdf","sizeBytes":12345 }
   -> 201 { sourceId, uploadUrl, s3KeyRaw }
3. PUT <uploadUrl> with the file bytes (browser/curl direct to S3) -> 200
4. POST /compose/sessions/<id>/sources/<sourceId>/uploaded -> 202
5. GET /compose/sessions/<id>/sources
   -> the source transitions pending -> converting -> converted, markdownContent populated
6. POST /compose/sessions/<id>/youtube { "url":"https://youtu.be/..." } -> 202 ; converts to a transcript source
7. POST /compose/sessions/<id>/handoff -> 202 ; the COMPOSE-<id> source's draft now includes the converted material as evidence
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/plans/2026-06-02-compose-sessions-phase-2-COMPLETION.md
git commit -m "docs(compose): Phase 2 completion notes"
```

---

## Self-Review

**1. Spec coverage (Phase-2 scope from the design doc):**
- Presigned S3 PUT upload path → Tasks 6, 8 (requestUpload/confirmUpload) + Task 9 (CORS). ✓
- markitdown sidecar (all non-audio incl. YouTube/ZIP/EPub/image-OCR) → Tasks 4, 5. ✓
- Conversion worker (claim → convert → workspace `.md` + DB) → Tasks 3, 7. ✓
- Per-source live status (pending→converting→converted/failed/unsupported) → Tasks 3, 8 (`listSources`/`GET sources`). ✓
- Retry on failure → Task 3 (`reconvertSource`) + Task 8 (`reconvert` route). ✓
- `unsupported` surfaced explicitly (not silently dropped) → Task 7 (audio → unsupported). ✓
- Replace Phase-1 note shortcut with `markdown_content` → Tasks 1, 3. ✓
- Audio deferred to Phase 4 → Task 7 routes audio to `unsupported` with a clear message. ✓ (intentional non-implementation)
- Frontend deferred → this phase exposes API + status data only; no React. ✓ (correct scope)

**2. Placeholder scan:** No "TBD/TODO/handle errors appropriately". Every code step shows full code. The `s3KeyRaw: ""` placeholder in `createUploadSource` (Task 8c) is immediately overwritten by `updateSourceS3Key` after the id is known — documented inline, not a gap. Task 9 is infra-only and explicitly says "no unit test; verify via fmt/validate/docker build."

**3. Type consistency:**
- `ComposeSessionSourceSummary.markdownContent` defined Task 2, written/read Tasks 3, surfaced Task 8. ✓
- `ComposeUploadTarget` defined Task 2, produced by `ComposeUploads.createUploadUrl` (Task 6), returned by `requestUpload` (Task 8). ✓
- Repo methods (`createUploadSource`, `createYoutubeSource`, `updateSourceS3Key`, `getSessionSource`, `listSessionSources`, `claimNextPendingSource`, `markSourceConverted/Failed/Unsupported`, `reconvertSource`) defined Task 3, consumed Tasks 7 (worker) + 8 (service) with matching signatures. ✓
- `MarkitdownClient.convertFile/convertUrl` defined Task 5, consumed Task 7. ✓
- `ComposeConversionWorker.drain/convertOne` defined Task 7, `drain` consumed by service (Task 8) + server interval (Task 8 Step 6). ✓
- `ComposeService` constructor param order `(composeRepository, specRepository, draftRequester, uploads, conversionWorker, config)` is consistent between Task 8 Step 3 and the server wiring Step 6. ✓

**Phase-2 → Phase-3 handoff:** converted sources now carry real `markdownContent`; Phase 3's "Analyze Sources" context pass + SSE chat reads them via the unchanged `listSessionSourceContents`. The conversion worker drains on each add and on a 5s interval; Phase 3 adds the chat agent loop and readiness gate on top.
