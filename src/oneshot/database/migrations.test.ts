import { readFile } from "fs/promises";
import path from "path";
import { describe, expect, it } from "vitest";

type AuditedTicketTypeRow = {
  jiraIssueType: string | null;
  ticketType: string;
  title: string;
  typeSource: string;
};

function unescapeSqlString(value: string): string {
  return value.replace(/''/g, "'");
}

function parseAuditedBackfillRows(
  sql: string,
): Map<string, { jiraIssueType: string | null; ticketType: string }> {
  const rows = new Map<
    string,
    { jiraIssueType: string | null; ticketType: string }
  >();
  const rowPattern =
    /(?:SELECT|UNION ALL SELECT)\s+'((?:''|[^'])+)'\s+AS\s+jira_key,\s+(NULL|'((?:''|[^'])*)')\s+AS\s+jira_issue_type,\s+'((?:''|[^'])+)'\s+AS\s+ticket_type/g;
  for (const match of sql.matchAll(rowPattern)) {
    const jiraKey = unescapeSqlString(match[1] ?? "");
    const rawIssueType = match[2] === "NULL"
      ? null
      : unescapeSqlString(match[3] ?? "");
    const ticketType = unescapeSqlString(match[4] ?? "");
    rows.set(jiraKey, { jiraIssueType: rawIssueType, ticketType });
  }
  return rows;
}

describe("migration 038 OneShot run branch contract", () => {
  it("guards run-branch DDL and backfills active candidate rows idempotently", async () => {
    const sql = await readFile(
      path.join(
        process.cwd(),
        "db",
        "migrations",
        "038_oneshot_run_branch_contract.sql",
      ),
      "utf8",
    );

    expect(sql).toContain("information_schema.columns");
    expect(sql).toContain("column_name = 'run_branch_name'");
    expect(sql).toContain("column_name = 'run_branch_base_sha'");
    expect(sql).toContain("column_name = 'run_branch_created_at'");
    expect(sql).toContain("information_schema.statistics");
    expect(sql).toContain("index_name = 'idx_oneshot_run_branch_name'");
    expect(sql).not.toContain("ADD COLUMN IF NOT EXISTS");

    expect(sql).toContain("CONCAT(");
    expect(sql).toContain("'oneshot/'");
    expect(sql).toContain("current_implementation_branch = run_branch_name");

    expect(sql).toContain("LEFT JOIN oneshot_candidate_versions current_cv");
    expect(sql).toContain("LEFT JOIN oneshot_candidate_versions version_cv");
    expect(sql).toContain("current_cv.id IS NULL");
    expect(sql).toContain("version_cv.id IS NULL");
    expect(sql).toContain(
      "JSON_UNQUOTE(JSON_EXTRACT(a.metadata_json, '$.implementationCommitSha'))",
    );
  });
});

describe("migration 039 OneShot candidate handoff repair", () => {
  it("normalizes workspace modes and backfills candidate handoff rows idempotently", async () => {
    const sql = await readFile(
      path.join(
        process.cwd(),
        "db",
        "migrations",
        "039_oneshot_candidate_handoff_repair.sql",
      ),
      "utf8",
    );

    expect(sql).toContain("UPDATE oneshot_runs");
    expect(sql).toContain("workspace_mode IS NULL OR workspace_mode <> 'v2'");
    expect(sql).toContain("UPDATE oneshot_workspace_state");
    expect(sql).toContain("INSERT INTO oneshot_candidate_versions");
    expect(sql).toContain("LEFT JOIN oneshot_candidate_versions current_cv");
    expect(sql).toContain("LEFT JOIN oneshot_candidate_versions version_cv");
    expect(sql).toContain("current_cv.id IS NULL");
    expect(sql).toContain("version_cv.id IS NULL");
    expect(sql).toContain(
      "JSON_UNQUOTE(JSON_EXTRACT(a.metadata_json, '$.implementationCommitSha'))",
    );
    expect(sql).toContain("migration_039_candidate_handoff_repair");
    expect(sql).toContain("SET cv.status = 'current'");
    expect(sql).toContain(
      "cv.candidate_version = r.current_implementation_version",
    );
    expect(sql).toContain(
      "cv.candidate_commit_sha = r.current_implementation_commit_sha",
    );
    expect(sql).toContain("JOIN oneshot_runs r");
    expect(sql).toContain("ws.current_candidate_version = cv.candidate_version");
    expect(sql).toContain("ws.current_candidate_sha = cv.candidate_commit_sha");
  });
});

describe("migration 044 OneShot ticket type", () => {
  it("adds ticket type columns, backfills from durable signals, and indexes type idempotently", async () => {
    const sql = await readFile(
      path.join(
        process.cwd(),
        "db",
        "migrations",
        "044_oneshot_ticket_type.sql",
      ),
      "utf8",
    );

    expect(sql).toContain("information_schema.columns");
    expect(sql).toContain("column_name = 'jira_issue_type'");
    expect(sql).toContain("column_name = 'ticket_type'");
    expect(sql).toContain("column_name = 'ticket_type_source'");
    expect(sql).toContain("column_name = 'ticket_type_updated_by'");
    expect(sql).toContain("column_name = 'ticket_type_updated_at'");
    expect(sql).toContain("REGEXP_SUBSTR(t.task_description");
    expect(sql).toContain("backfill_jira_issue_type");
    expect(sql).toContain("JSON_EXTRACT(qa.metadata_json, '$.processing_mode')");
    expect(sql).toContain("backfill_processing_mode");
    expect(sql).toContain("REGEXP_SUBSTR(t.task_description, '^# Task:");
    expect(sql).toContain("backfill_title");
    expect(sql).toContain("backfill_retrofit_title");
    expect(sql).toContain("retro(fit)?|forward[- ]?port|back[- ]?port");
    expect(sql).toContain("information_schema.statistics");
    expect(sql).toContain("index_name = 'idx_oneshot_ticket_type'");
    expect(sql).not.toContain("ADD COLUMN IF NOT EXISTS");
  });
});

describe("migration 045 OneShot audited ticket type backfill", () => {
  it("matches the refreshed run-backed Jira audit without overwriting manual overrides", async () => {
    const [sql, fixtureRaw] = await Promise.all([
      readFile(
        path.join(
          process.cwd(),
          "db",
          "migrations",
          "045_oneshot_ticket_type_audited_backfill.sql",
        ),
        "utf8",
      ),
      readFile(
        path.join(
          process.cwd(),
          "src",
          "oneshot",
          "database",
          "fixtures",
          "oneshot-ticket-type-audit-2026-06-08.json",
        ),
        "utf8",
      ),
    ]);
    const audit = JSON.parse(fixtureRaw) as Record<string, AuditedTicketTypeRow>;
    const migrationRows = parseAuditedBackfillRows(sql);

    expect(sql).toContain("backfill_audited_jira_snapshot");
    expect(sql).toContain("COALESCE(r.ticket_type_source, '') <> 'manual'");
    expect(sql).toContain("r.ticket_type_updated_by IS NULL");
    expect(sql).toContain("r.ticket_type_updated_at IS NULL");

    expect(migrationRows.size).toBe(Object.keys(audit).length);
    for (const [jiraKey, expected] of Object.entries(audit)) {
      expect(migrationRows.get(jiraKey)).toEqual({
        jiraIssueType: expected.jiraIssueType,
        ticketType: expected.ticketType,
      });
    }

    const mappedTypes = new Set(
      [...migrationRows.values()].map((row) => row.ticketType),
    );
    expect(mappedTypes).toEqual(
      new Set(["story", "defect", "sonar", "security", "retrofit", "other"]),
    );
    expect(mappedTypes).not.toContain("unknown");

    const retrofitKeys = Object.entries(audit)
      .filter(([, row]) => row.ticketType === "retrofit")
      .map(([jiraKey]) => jiraKey);
    expect(retrofitKeys.length).toBeGreaterThan(0);
    for (const jiraKey of retrofitKeys) {
      expect(migrationRows.get(jiraKey)?.ticketType).toBe("retrofit");
    }
  });
});

describe("migration 049 OneShot blocked-client policy", () => {
  it("creates blocked-client policy and audit tables and keeps schema.sql aligned", async () => {
    const [migrationSql, schemaSql] = await Promise.all([
      readFile(
        path.join(
          process.cwd(),
          "db",
          "migrations",
          "049_oneshot_blocked_clients.sql",
        ),
        "utf8",
      ),
      readFile(path.join(process.cwd(), "db", "schema.sql"), "utf8"),
    ]);

    for (const sql of [migrationSql, schemaSql]) {
      expect(sql).toContain("CREATE TABLE IF NOT EXISTS oneshot_blocked_clients");
      expect(sql).toContain("client_key");
      expect(sql).toContain("display_name");
      expect(sql).toContain("reason");
      expect(sql).toContain("is_active");
      expect(sql).toContain("created_by");
      expect(sql).toContain("updated_by");
      expect(sql).toContain("UNIQUE KEY uk_oneshot_blocked_clients_key");
      expect(sql).toContain(
        "CREATE TABLE IF NOT EXISTS oneshot_blocked_client_audit_events",
      );
      expect(sql).toContain("action");
      expect(sql).toContain("old_snapshot_json");
      expect(sql).toContain("new_snapshot_json");
      expect(sql).toContain("idx_oneshot_blocked_client_audit_key");
    }
  });
});

describe("migration 050 OneShot branch-scoped active run key", () => {
  it("keeps active duplicate-run protection scoped by Jira, repo, and branch", async () => {
    const [migrationSql, schemaSql] = await Promise.all([
      readFile(
        path.join(
          process.cwd(),
          "db",
          "migrations",
          "050_oneshot_branch_scoped_active_run_key.sql",
        ),
        "utf8",
      ),
      readFile(path.join(process.cwd(), "db", "schema.sql"), "utf8"),
    ]);

    expect(migrationSql).toContain("DROP INDEX uk_active_jira_repo");
    expect(migrationSql).toContain("DROP COLUMN active_jira_repo_key");
    expect(migrationSql).toContain("ADD UNIQUE KEY uk_active_jira_repo");

    for (const sql of [migrationSql, schemaSql]) {
      expect(sql).toContain("active_jira_repo_key           VARCHAR(360)");
      expect(sql).toContain("state IN ('completed', 'blocked', 'failed')");
      expect(sql).toContain(
        "CONCAT(jira_key, '#', repo_id, '#', branch_name)",
      );
    }
  });
});

describe("migration 051 OneShot Epic key", () => {
  it("persists nullable Epic keys and keeps the canonical schema aligned", async () => {
    const [migrationSql, schemaSql] = await Promise.all([
      readFile(
        path.join(
          process.cwd(),
          "db",
          "migrations",
          "051_oneshot_epic_key.sql",
        ),
        "utf8",
      ),
      readFile(path.join(process.cwd(), "db", "schema.sql"), "utf8"),
    ]);

    expect(migrationSql).toContain(
      "ADD COLUMN epic_key VARCHAR(50) NULL AFTER jira_key",
    );
    expect(migrationSql).toContain(
      "ADD INDEX idx_oneshot_epic_key (epic_key)",
    );

    expect(schemaSql).toContain("epic_key                       VARCHAR(50)  NULL");
    expect(schemaSql).toContain("INDEX idx_oneshot_epic_key (epic_key)");
  });
});
