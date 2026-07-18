import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import { SpecFactoryRepository } from "./database.js";
import type { SpecFactoryDraftBundle } from "./types.js";

const queryMock = vi.fn();
const getConnectionMock = vi.fn();

function repository() {
  return new SpecFactoryRepository({
    query: queryMock,
    getConnection: getConnectionMock,
  } as any);
}

function validBundle(
  overrides: Partial<SpecFactoryDraftBundle> = {},
): SpecFactoryDraftBundle {
  return {
    sourceJiraKey: "CPDEV-22410",
    loeHours: 38,
    epic: {
      summary: "Automate enrollment sync validation for Client A",
      description:
        "Client A needs repeatable validation for enrollment sync rules.",
      businessContext: ["Louise estimated this as a cross-repo delivery item."],
      acceptanceCriteria: [
        "Generated child tickets cover each repo-specific change.",
      ],
      assumptions: [
        "Default branch is used unless the source ticket names a branch.",
      ],
      dependencies: ["Config rollout depends on backend validation behavior."],
    },
    childTickets: [
      {
        repoName: "core-app",
        summary: "[core-app] Add enrollment sync validation",
        overview: "Implement backend validation for enrollment sync rules.",
        acceptanceCriteria: [
          "The service rejects enrollment sync payloads that violate Client A rules.",
          "Existing enrollment sync behavior remains unchanged for other clients.",
        ],
        technicalDetails: {
          repo: "core-app",
          branch: "master",
          targetFiles: ["service/EnrollmentSyncValidator.java"],
          implementationNotes: [
            "Use the existing validation service entry point.",
          ],
        },
        outOfScope: ["Do not change UI behavior."],
        testingNotes: ["Run enrollment sync unit tests."],
        loeHours: 20,
        sourceEvidenceRefs: ["attachment:loe-estimate.md"],
      },
    ],
    evidenceSummary: ["loe-estimate.md indicates 38 total hours."],
    warnings: [],
    ...overrides,
  };
}

function transactionalConnection() {
  return {
    beginTransaction: vi.fn().mockResolvedValue(undefined),
    query: vi.fn(),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    release: vi.fn(),
  };
}

function latestDraftRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 44,
    source_id: 12,
    version: 2,
    evidence_snapshot_id: null,
    status: "ready",
    draft_json: JSON.stringify(validBundle()),
    rendered_markdown: "# Draft",
    evidence_manifest_json: JSON.stringify({ refs: ["jira:CPDEV-22410"] }),
    error_message: null,
    created_at: new Date("2026-05-27T12:00:00Z"),
    updated_at: new Date("2026-05-27T12:05:00Z"),
    ...overrides,
  };
}

function childRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 99,
    repo_name: "core-app",
    summary: "[core-app] Add enrollment sync validation",
    description: "Persisted child description",
    loe_hours: "20.00",
    jira_key: "CPDEV-22411",
    state: "draft",
    oneshot_request_id: null,
    oneshot_run_id: null,
    error_message: null,
    ...overrides,
  };
}

describe("SpecFactoryRepository", () => {
  beforeEach(() => {
    queryMock.mockReset();
    getConnectionMock.mockReset();
  });

  it("keeps the fresh schema aligned with qualification archive migration columns", () => {
    const schema = readFileSync("db/schema.sql", "utf8");
    const sourcesTable = schema.match(
      /CREATE TABLE IF NOT EXISTS spec_factory_sources \([\s\S]*?\) ENGINE=/,
    )?.[0];
    const draftsTable = schema.match(
      /CREATE TABLE IF NOT EXISTS spec_factory_drafts \([\s\S]*?\) ENGINE=/,
    )?.[0];
    const childTicketsTable = schema.match(
      /CREATE TABLE IF NOT EXISTS spec_factory_child_tickets \([\s\S]*?\) ENGINE=/,
    )?.[0];
    const composeSessionsTable = schema.match(
      /CREATE TABLE IF NOT EXISTS compose_sessions \([\s\S]*?\) ENGINE=/,
    )?.[0];
    const composeSourcesTable = schema.match(
      /CREATE TABLE IF NOT EXISTS compose_session_sources \([\s\S]*?\) ENGINE=/,
    )?.[0];
    const llmCallsTable = schema.match(
      /CREATE TABLE IF NOT EXISTS spec_factory_llm_calls \([\s\S]*?\) ENGINE=/,
    )?.[0];

    expect(sourcesTable).toContain("'not_qualified'");
    expect(sourcesTable).toMatch(
      /approved_epic_key\s+VARCHAR\(50\)\s+NULL,\s+qualification_reasons_json\s+JSON\s+NULL,/,
    );
    expect(draftsTable).toContain(
      "INDEX idx_spec_factory_drafts_id_source (id, source_id)",
    );
    expect(draftsTable).not.toContain(
      "UNIQUE KEY uk_spec_factory_drafts_id_source (id, source_id)",
    );
    expect(childTicketsTable).toContain(
      "FOREIGN KEY (draft_id) REFERENCES spec_factory_drafts(id)",
    );
    expect(childTicketsTable).not.toContain(
      "FOREIGN KEY (draft_id, source_id) REFERENCES spec_factory_drafts(id, source_id)",
    );
    expect(childTicketsTable).not.toContain(
      "UNIQUE KEY uk_spec_factory_child_repo",
    );
    expect(childTicketsTable).toContain(
      "INDEX idx_spec_factory_child_draft_repo (draft_id, repo_name)",
    );
    expect(composeSessionsTable).toContain(
      "UNIQUE KEY uk_compose_sessions_source_id (source_id)",
    );
    expect(composeSessionsTable).toContain("password_hash");
    expect(composeSourcesTable).toContain("conversion_started_at");
    expect(composeSourcesTable).toContain("conversion_attempts");
    expect(composeSourcesTable).toContain("conversion_lease_expires_at");
    expect(llmCallsTable).toContain("session_id BIGINT NULL");
    expect(llmCallsTable).toContain("turn_job_id BIGINT NULL");
    expect(llmCallsTable).toContain("agent_task_id BIGINT NULL");
    expect(llmCallsTable).toContain(
      "created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)",
    );
    expect(llmCallsTable).toContain(
      "INDEX idx_spec_factory_llm_calls_provider_model (provider, model, created_at)",
    );
  });

  it("adds the global LLM call audit table without Compose-only foreign keys", () => {
    const migration = readFileSync(
      "db/migrations/058_spec_factory_llm_calls.sql",
      "utf8",
    );

    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS spec_factory_llm_calls",
    );
    expect(migration).toContain("session_id BIGINT NULL");
    expect(migration).toContain("turn_job_id BIGINT NULL");
    expect(migration).toContain("agent_task_id BIGINT NULL");
    expect(migration).not.toContain("FOREIGN KEY");
  });

  it("deduplicates generated research task links before adding the unique key", () => {
    const migration = readFileSync(
      "db/migrations/059_compose_generated_research_idempotency.sql",
      "utf8",
    );

    expect(migration).toContain("UPDATE compose_session_sources s");
    expect(migration).toContain("HAVING COUNT(*) > 1");
    expect(migration).toContain(
      "MIN(CASE WHEN t.output_source_id = s2.id THEN s2.id END)",
    );
    expect(migration).toContain("SET s.generated_by_task_id = NULL");
    expect(migration.indexOf("UPDATE compose_session_sources s")).toBeLessThan(
      migration.indexOf(
        "ADD UNIQUE KEY uk_compose_session_sources_generated_task",
      ),
    );
  });

  it("persists clarification idempotency per answer before adding its unique key", () => {
    const schema = readFileSync("db/schema.sql", "utf8");
    const messagesTable = schema.match(
      /CREATE TABLE IF NOT EXISTS compose_session_messages \([\s\S]*?\) ENGINE=/,
    )?.[0];
    const migration = readFileSync(
      "db/migrations/076_compose_clarification_answer_history.sql",
      "utf8",
    );

    expect(messagesTable).toContain(
      "clarification_idempotency_key VARCHAR(128) NULL",
    );
    expect(messagesTable).toContain(
      "UNIQUE KEY uniq_compose_messages_clarification_idem",
    );
    expect(migration).toContain("information_schema.columns");
    expect(migration).toContain("information_schema.statistics");
    expect(migration).toContain("UPDATE compose_session_messages message");
    expect(migration).toContain(
      "turn.clarification_answer_message_id = message.id",
    );
    expect(
      migration.indexOf("UPDATE compose_session_messages message"),
    ).toBeLessThan(
      migration.indexOf(
        "ADD UNIQUE KEY uniq_compose_messages_clarification_idem",
      ),
    );
  });

  it("adds recoverable source deletion state with purge-safe indexes", () => {
    const schema = readFileSync("db/schema.sql", "utf8");
    const composeSourcesTable = schema.match(
      /CREATE TABLE IF NOT EXISTS compose_session_sources \([\s\S]*?\) ENGINE=/,
    )?.[0];
    const sourceDeletionsTable = schema.match(
      /CREATE TABLE IF NOT EXISTS compose_source_deletions \([\s\S]*?\) ENGINE=/,
    )?.[0];
    const migration = readFileSync(
      "db/migrations/075_spec_factory_source_deletion_lifecycle.sql",
      "utf8",
    );

    expect(composeSourcesTable).toMatch(/deletion_id\s+BIGINT\s+NULL/);
    expect(composeSourcesTable).toMatch(/purged_at\s+TIMESTAMP\(3\)\s+NULL/);
    expect(composeSourcesTable).toContain(
      "INDEX idx_compose_session_sources_deletion (deletion_id, deleted_at, id)",
    );
    expect(sourceDeletionsTable).toContain("undo_until");
    expect(sourceDeletionsTable).toContain(
      "INDEX idx_compose_source_deletions_purge (status, undo_until, id)",
    );
    expect(sourceDeletionsTable).toContain(
      "FOREIGN KEY (source_id) REFERENCES compose_session_sources(id)",
    );
    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS compose_source_deletions",
    );
    expect(migration).toContain("ADD COLUMN deletion_id BIGINT NULL");
    expect(migration).toContain("ADD COLUMN purged_at TIMESTAMP(3) NULL");
  });

  it("constrains durable event turn and task correlations without blocking reset", () => {
    const schema = readFileSync("db/schema.sql", "utf8");
    const eventsTable = schema.match(
      /CREATE TABLE IF NOT EXISTS compose_session_events \([\s\S]*?\) ENGINE=/,
    )?.[0];
    const migration = readFileSync(
      "db/migrations/066_compose_session_event_correlation_fks.sql",
      "utf8",
    );

    expect(eventsTable).toContain(
      "CONSTRAINT fk_compose_session_events_turn_job",
    );
    expect(eventsTable).toContain(
      "FOREIGN KEY (turn_job_id) REFERENCES compose_turn_jobs(id) ON DELETE SET NULL",
    );
    expect(eventsTable).toContain(
      "CONSTRAINT fk_compose_session_events_agent_task",
    );
    expect(eventsTable).toContain(
      "FOREIGN KEY (agent_task_id) REFERENCES compose_agent_tasks(id) ON DELETE SET NULL",
    );

    expect(migration).toContain("UPDATE compose_session_events e");
    expect(migration).toContain("LEFT JOIN compose_turn_jobs j");
    expect(migration).toContain("SET e.turn_job_id = NULL");
    expect(migration).toContain("LEFT JOIN compose_agent_tasks t");
    expect(migration).toContain("SET e.agent_task_id = NULL");
    expect(migration.indexOf("SET e.turn_job_id = NULL")).toBeLessThan(
      migration.indexOf("ADD CONSTRAINT fk_compose_session_events_turn_job"),
    );
    expect(migration.indexOf("SET e.agent_task_id = NULL")).toBeLessThan(
      migration.indexOf("ADD CONSTRAINT fk_compose_session_events_agent_task"),
    );
  });

  it("persists request correlation across every asynchronous Spec Factory ledger", () => {
    const migration = readFileSync(
      "db/migrations/068_spec_factory_correlation_ids.sql",
      "utf8",
    );
    const expectedTables = [
      "spec_factory_events",
      "spec_factory_processing_jobs",
      "compose_turn_jobs",
      "compose_agent_tasks",
      "spec_factory_llm_calls",
      "compose_session_events",
    ];

    for (const table of expectedTables) {
      expect(migration).toContain(`table_name = '${table}'`);
      expect(migration).toContain(
        `ALTER TABLE ${table} ADD COLUMN request_id VARCHAR(128) NULL`,
      );
    }
    expect(migration).toContain("information_schema.columns");
    expect(migration).toContain("information_schema.statistics");
  });

  it("migrates child tickets to allow multiple modular stories for the same repo", () => {
    const migration = readFileSync(
      "db/migrations/053_spec_factory_multiple_child_stories_per_repo.sql",
      "utf8",
    );

    expect(migration).toContain("DROP INDEX uk_spec_factory_child_repo");
    expect(migration).toContain(
      "ADD INDEX idx_spec_factory_child_draft_repo (draft_id, repo_name)",
    );
  });

  it("inserts a newly discovered Louise source during intake", async () => {
    queryMock
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([{ affectedRows: 1, insertId: 12 }])
      .mockResolvedValueOnce([[{ id: 12 }]]);

    await expect(
      repository().upsertSource({
        sourceJiraKey: "CPDEV-22410",
        sourceSummary: "Enrollment sync rules",
        sourceStatus: "In Progress",
        sourceLabels: ["louise-estimated"],
        loeHours: 38,
      }),
    ).resolves.toEqual({ id: 12, inserted: true });

    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("SELECT id FROM spec_factory_sources"),
      ["CPDEV-22410"],
    );
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("INSERT IGNORE INTO spec_factory_sources"),
      expect.arrayContaining([
        "CPDEV-22410",
        "Enrollment sync rules",
        "In Progress",
      ]),
    );
  });

  it("does not update an existing source during intake refresh", async () => {
    queryMock.mockResolvedValueOnce([[{ id: 12 }]]);

    await expect(
      repository().upsertSource({
        sourceJiraKey: "CPDEV-22410",
        sourceSummary: "Updated Jira summary",
        sourceStatus: "Done",
        sourceLabels: ["louise-estimated"],
        loeHours: 55,
      }),
    ).resolves.toEqual({ id: 12, inserted: false });

    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("SELECT id FROM spec_factory_sources"),
      ["CPDEV-22410"],
    );
  });

  it("maps Louise board rows into source summaries", async () => {
    queryMock.mockResolvedValueOnce([
      [
        {
          id: 12,
          source_jira_key: "CPDEV-22410",
          source_summary: "Enrollment sync rules",
          source_status: "In Progress",
          loe_hours: "38.00",
          state: "draft_ready",
          origin: "louise",
          approved_epic_key: null,
          updated_at: new Date("2026-05-27T12:00:00Z"),
        },
      ],
    ]);

    await expect(repository().listLouiseBoardSources()).resolves.toEqual([
      {
        id: 12,
        sourceJiraKey: "CPDEV-22410",
        sourceSummary: "Enrollment sync rules",
        sourceStatus: "In Progress",
        loeHours: 38,
        state: "draft_ready",
        origin: "louise",
        approvedEpicKey: null,
        qualificationReasons: [],
        errorMessage: null,
        updatedAt: "2026-05-27T12:00:00.000Z",
      },
    ]);
  });

  it("maps the origin column on board sources, defaulting to louise", async () => {
    queryMock.mockResolvedValueOnce([
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
        {
          id: 2,
          source_jira_key: "CPDEV-2",
          source_summary: "Legacy source without origin",
          source_status: null,
          loe_hours: null,
          state: "draft_ready",
          approved_epic_key: null,
          qualification_reasons_json: null,
          error_message: null,
          updated_at: "2026-06-02T00:00:00.000Z",
        },
      ],
    ]);

    const sources = await repository().listLouiseBoardSources();
    expect(sources[0].origin).toBe("compose");
    expect(sources[1].origin).toBe("louise");
  });

  it("marks a source as drafting before preview generation", async () => {
    queryMock.mockResolvedValueOnce([{ affectedRows: 1 }]);

    await repository().markSourceDrafting(12);

    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("SET state = 'drafting'"),
      [12],
    );
  });

  it("restores an archived source to the best active board state", async () => {
    queryMock.mockResolvedValueOnce([{ affectedRows: 1 }]);

    await expect(repository().restoreArchivedSource(12)).resolves.toBe(true);

    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toContain("approved_epic_key IS NOT NULL");
    expect(sql).toContain("d.status = 'ready'");
    expect(sql).toContain("ELSE 'candidate'");
    expect(sql).toContain("state = 'archived'");
    expect(queryMock.mock.calls[0][1]).toEqual([12]);
  });

  it("backfills source LOE when creating an evidence snapshot", async () => {
    queryMock
      .mockResolvedValueOnce([{ insertId: 501 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    await expect(
      repository().createEvidenceSnapshot({
        sourceId: 12,
        manifest: {
          sourceJiraKey: "CPDEV-22410",
          sourceSummary: "Enrollment sync rules",
          sourceStatus: "In Progress",
          sourceLabels: ["louise-estimated"],
          descriptionMarkdown: "Requirement text",
          comments: [],
          loeHours: 144,
          loeSource: "attachment:LOE-CPDEV-22410.md",
          artifacts: [],
          repoReferences: {
            matchedRepos: [],
            unresolvedHints: [],
            warnings: [],
          },
          warnings: [],
        },
      }),
    ).resolves.toBe(501);

    expect(queryMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("SET loe_hours = ?"),
      [144, 12],
    );
  });

  it("lists attachment archive rows for a source in operator-friendly order", async () => {
    queryMock.mockResolvedValueOnce([
      [
        {
          id: 12,
          source_id: 7,
          jira_attachment_id: "att-2",
          filename: "Development-Plan.md",
          mime_type: "text/markdown",
          size_bytes: "2400",
          artifact_kind: "code-change",
          is_priority: 1,
          s3_bucket: "specter-results",
          s3_key:
            "spec-factory/CPDEV-22410/attachments/att-2-Development-Plan.md",
          sha256: "a".repeat(64),
          extracted_text: "Implement the API validation.",
          extraction_status: "extracted",
          error_message: null,
          created_at: "2026-06-01T12:00:00.000Z",
          updated_at: "2026-06-01T12:01:00.000Z",
        },
      ],
    ]);

    await expect(repository().listSourceAttachments(7)).resolves.toEqual([
      {
        id: 12,
        sourceId: 7,
        jiraAttachmentId: "att-2",
        filename: "Development-Plan.md",
        mimeType: "text/markdown",
        sizeBytes: 2400,
        artifactKind: "code-change",
        isPriority: true,
        s3Bucket: "specter-results",
        s3Key: "spec-factory/CPDEV-22410/attachments/att-2-Development-Plan.md",
        sha256: "a".repeat(64),
        extractedText: "Implement the API validation.",
        extractionStatus: "extracted",
        errorMessage: null,
        createdAt: "2026-06-01T12:00:00.000Z",
        updatedAt: "2026-06-01T12:01:00.000Z",
      },
    ]);

    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("FROM spec_factory_attachments"),
      [7],
    );
    expect(String(queryMock.mock.calls[0][0])).toContain(
      "ORDER BY is_priority DESC",
    );
  });

  it("creates a draft and marks the source ready in one committed transaction", async () => {
    const connection = transactionalConnection();
    connection.query
      .mockResolvedValueOnce([{ insertId: 44 }])
      .mockResolvedValueOnce([{ insertId: 99 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);
    getConnectionMock.mockResolvedValueOnce(connection);

    await expect(
      repository().createDraft({
        sourceId: 12,
        version: 2,
        bundle: validBundle(),
        renderedMarkdown: "# Draft",
        evidenceManifest: { refs: ["jira:CPDEV-22410"] },
        modelMetadata: { model: "test-model" },
      }),
    ).resolves.toBe(44);

    expect(connection.beginTransaction).toHaveBeenCalledOnce();
    expect(connection.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("INSERT INTO spec_factory_drafts"),
      expect.arrayContaining([12, 2]),
    );
    expect(connection.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("INSERT INTO spec_factory_child_tickets"),
      [
        12,
        44,
        null,
        "core-app",
        "[core-app] Add enrollment sync validation",
        expect.stringContaining("Repo: core-app"),
        20,
      ],
    );
    expect(connection.query.mock.calls[1][1][5]).toContain(
      "Use the existing validation service entry point.",
    );
    expect(connection.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("UPDATE spec_factory_sources"),
      [12],
    );
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledOnce();
  });

  it("revises a draft by superseding the previous version and inserting a ready version", async () => {
    const connection = transactionalConnection();
    connection.query
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ insertId: 45 }])
      .mockResolvedValueOnce([{ insertId: 100 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);
    getConnectionMock.mockResolvedValueOnce(connection);

    await expect(
      repository().reviseDraft({
        sourceId: 12,
        previousDraftId: 44,
        version: 3,
        bundle: validBundle({
          epic: {
            ...validBundle().epic,
            summary: "Edited enrollment validation",
          },
        }),
        renderedMarkdown: "# Edited Draft",
        evidenceManifest: { refs: ["jira:CPDEV-22410"] },
        modelMetadata: { source: "operator_edit", actor: "kkompalli" },
      }),
    ).resolves.toBe(45);

    expect(connection.beginTransaction).toHaveBeenCalledOnce();
    expect(connection.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("status = 'superseded'"),
      [44, 12],
    );
    expect(connection.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("INSERT INTO spec_factory_drafts"),
      expect.arrayContaining([12, 3]),
    );
    expect(connection.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("INSERT INTO spec_factory_child_tickets"),
      expect.arrayContaining([12, 45, null, "core-app"]),
    );
    expect(connection.query).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining("UPDATE spec_factory_sources"),
      [12],
    );
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledOnce();
  });

  it("rolls back and releases the transaction when child insert fails", async () => {
    const connection = transactionalConnection();
    const childInsertError = new Error("child insert failed");
    connection.query
      .mockResolvedValueOnce([{ insertId: 44 }])
      .mockRejectedValueOnce(childInsertError);
    getConnectionMock.mockResolvedValueOnce(connection);

    await expect(
      repository().createDraft({
        sourceId: 12,
        version: 2,
        bundle: validBundle(),
        renderedMarkdown: "# Draft",
        evidenceManifest: { refs: ["jira:CPDEV-22410"] },
        modelMetadata: { model: "test-model" },
      }),
    ).rejects.toThrow("child insert failed");

    expect(connection.beginTransaction).toHaveBeenCalledOnce();
    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(connection.release).toHaveBeenCalledOnce();
  });

  it("rolls back and releases the transaction when source update fails", async () => {
    const connection = transactionalConnection();
    const updateError = new Error("update failed");
    connection.query
      .mockResolvedValueOnce([{ insertId: 44 }])
      .mockResolvedValueOnce([{ insertId: 99 }])
      .mockRejectedValueOnce(updateError);
    getConnectionMock.mockResolvedValueOnce(connection);

    await expect(
      repository().createDraft({
        sourceId: 12,
        version: 2,
        bundle: validBundle(),
        renderedMarkdown: "# Draft",
        evidenceManifest: { refs: ["jira:CPDEV-22410"] },
        modelMetadata: { model: "test-model" },
      }),
    ).rejects.toThrow("update failed");

    expect(connection.beginTransaction).toHaveBeenCalledOnce();
    expect(connection.query).toHaveBeenCalledTimes(3);
    expect(connection.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("UPDATE spec_factory_sources"),
      [12],
    );
    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(connection.release).toHaveBeenCalledOnce();
  });

  it("maps valid latest draft JSON and child rows into draft detail", async () => {
    queryMock
      .mockResolvedValueOnce([[latestDraftRow()]])
      .mockResolvedValueOnce([[childRow()]]);

    await expect(repository().getLatestDraft(12)).resolves.toMatchObject({
      id: 44,
      sourceId: 12,
      version: 2,
      evidenceSnapshotId: null,
      status: "ready",
      draft: validBundle(),
      renderedMarkdown: "# Draft",
      evidenceManifest: { refs: ["jira:CPDEV-22410"] },
      childTickets: [
        {
          id: 99,
          repoName: "core-app",
          summary: "[core-app] Add enrollment sync validation",
          description: "Persisted child description",
          loeHours: 20,
          jiraKey: "CPDEV-22411",
          state: "draft",
          oneshotRequestId: null,
          oneshotRunId: null,
          errorMessage: null,
        },
      ],
      errorMessage: null,
      createdAt: "2026-05-27T12:00:00.000Z",
      updatedAt: "2026-05-27T12:05:00.000Z",
    });
  });

  it("returns draft null when stored latest draft JSON is invalid", async () => {
    queryMock
      .mockResolvedValueOnce([
        [
          latestDraftRow({
            draft_json: JSON.stringify({ sourceJiraKey: "not-a-key" }),
          }),
        ],
      ])
      .mockResolvedValueOnce([[]]);

    await expect(repository().getLatestDraft(12)).resolves.toMatchObject({
      id: 44,
      sourceId: 12,
      status: "ready",
      draft: null,
      renderedMarkdown: "# Draft",
      evidenceManifest: { refs: ["jira:CPDEV-22410"] },
      childTickets: [],
    });
  });

  it("returns draft null when stored latest draft JSON is malformed", async () => {
    queryMock
      .mockResolvedValueOnce([[latestDraftRow({ draft_json: "{not-json" })]])
      .mockResolvedValueOnce([[]]);

    await expect(repository().getLatestDraft(12)).resolves.toMatchObject({
      id: 44,
      sourceId: 12,
      status: "ready",
      draft: null,
      evidenceManifest: { refs: ["jira:CPDEV-22410"] },
      childTickets: [],
    });
  });

  it("returns draft null instead of rejecting when draft status is invalid", async () => {
    queryMock
      .mockResolvedValueOnce([[latestDraftRow({ status: "not-a-status" })]])
      .mockResolvedValueOnce([[]]);

    await expect(repository().getLatestDraft(12)).resolves.toMatchObject({
      id: 44,
      sourceId: 12,
      status: "failed",
      draft: null,
      childTickets: [],
    });
  });

  it("returns draft null instead of rejecting when a child ticket state is invalid", async () => {
    queryMock
      .mockResolvedValueOnce([[latestDraftRow()]])
      .mockResolvedValueOnce([[childRow({ state: "not-a-child-state" })]]);

    await expect(repository().getLatestDraft(12)).resolves.toMatchObject({
      id: 44,
      sourceId: 12,
      status: "ready",
      draft: null,
      childTickets: [],
    });
  });

  it("returns draft null when evidence manifest JSON is malformed", async () => {
    queryMock
      .mockResolvedValueOnce([
        [latestDraftRow({ evidence_manifest_json: "{not-json" })],
      ])
      .mockResolvedValueOnce([[]]);

    await expect(repository().getLatestDraft(12)).resolves.toMatchObject({
      id: 44,
      sourceId: 12,
      status: "ready",
      draft: null,
      evidenceManifest: null,
      childTickets: [],
    });
  });

  it("loads a source with the next draft version", async () => {
    queryMock.mockResolvedValueOnce([
      [
        {
          id: 12,
          source_jira_key: "CPDEV-22410",
          source_summary: "Enrollment sync rules",
          source_status: "In Progress",
          loe_hours: "38.00",
          state: "candidate",
          origin: "louise",
          approved_epic_key: null,
          updated_at: new Date("2026-05-27T12:00:00Z"),
          next_draft_version: "3",
        },
      ],
    ]);

    await expect(repository().getSourceById(12)).resolves.toEqual({
      id: 12,
      sourceJiraKey: "CPDEV-22410",
      sourceSummary: "Enrollment sync rules",
      sourceStatus: "In Progress",
      loeHours: 38,
      state: "candidate",
      origin: "louise",
      approvedEpicKey: null,
      qualificationReasons: [],
      errorMessage: null,
      updatedAt: "2026-05-27T12:00:00.000Z",
      nextDraftVersion: 3,
    });
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("MAX(d.version)"),
      [12],
    );
  });

  it("updates approval state for drafts, sources, and created children", async () => {
    queryMock
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    await repository().markDraftApproved(44, "kkompalli");
    await repository().updateSourceApproved(12, "CPDEV-22411");
    await repository().updateChildCreated(99, "CPDEV-22412");

    expect(queryMock).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("approved_by = ?"),
      ["kkompalli", 44],
    );
    expect(queryMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("approved_epic_key = ?"),
      ["CPDEV-22411", 12],
    );
    expect(queryMock).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("jira_key = ?"),
      ["CPDEV-22412", 99],
    );
  });

  it("lists only created approved children with Jira keys", async () => {
    queryMock.mockResolvedValueOnce([
      [childRow({ state: "created", jira_key: "CPDEV-22412" })],
    ]);

    await expect(repository().listApprovedChildren(12)).resolves.toEqual([
      expect.objectContaining({
        id: 99,
        description: "Persisted child description",
        jiraKey: "CPDEV-22412",
        state: "created",
      }),
    ]);
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("d.status = 'approved'"),
      [12],
    );
    expect(queryMock.mock.calls[0][0]).toContain("c.state = 'created'");
    expect(queryMock.mock.calls[0][0]).toContain("MAX(latest.version)");
    expect(queryMock.mock.calls[0][0]).not.toContain("oneshot_requested");
  });

  it("guards child OneShot submission updates to first submission only", async () => {
    queryMock
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ insertId: 702 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    await repository().updateChildSubmitted(99, 701);
    await repository().markSourceOneShotSubmitted(12);
    await repository().recordEvent(12, "oneshot_submitted", "kkompalli", {
      requestId: 701,
    });
    await repository().markSourceNeedsAttention(12, "missing repo");

    expect(queryMock).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining(
        "oneshot_request_id = COALESCE(oneshot_request_id, ?)",
      ),
      ["oneshot_requested", 701, 99],
    );
    expect(queryMock.mock.calls[0][0]).toContain("state = 'created'");
    expect(queryMock.mock.calls[0][0]).toContain("oneshot_request_id IS NULL");
    expect(queryMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("submitted_at = CURRENT_TIMESTAMP(3)"),
      [12],
    );
    expect(queryMock).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("INSERT INTO spec_factory_events"),
      [
        12,
        "oneshot_submitted",
        "kkompalli",
        null,
        JSON.stringify({ requestId: 701 }),
      ],
    );
    expect(queryMock).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining("state = 'needs_attention'"),
      [JSON.stringify(["generation_failed"]), "missing repo", 12],
    );
  });

  it("preserves ready, approved, and submitted work when regeneration fails", async () => {
    queryMock.mockResolvedValueOnce([{ affectedRows: 1 }]);

    await repository().markDraftGenerationFailed({
      sourceId: 12,
      stateWithoutReadyDraft: "needs_attention",
      reasons: ["generation_failed"],
      errorMessage: "SDK timeout after 1200000ms",
    });

    const [sql, params] = queryMock.mock.calls[0];
    expect(String(sql)).toContain("THEN 'draft_ready'");
    expect(String(sql)).toContain(
      "s.state IN ('approved', 'oneshot_submitted')",
    );
    expect(String(sql)).toContain("s.approved_epic_key IS NOT NULL");
    expect(String(sql)).toContain("d.status IN ('ready', 'approved')");
    expect(String(sql)).toContain("ELSE ?");
    expect(params).toEqual([
      "needs_attention",
      JSON.stringify(["generation_failed"]),
      "SDK timeout after 1200000ms",
      12,
    ]);
  });

  it("expires stale queued processing jobs and repairs drafting source state", async () => {
    const queuedBefore = new Date("2026-06-01T12:00:00.000Z");
    queryMock
      .mockResolvedValueOnce([
        [
          { id: 187, source_id: 254 },
          { id: 188, source_id: 209 },
        ],
      ])
      .mockResolvedValueOnce([{ affectedRows: 2 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    await expect(
      repository().expireStaleQueuedProcessingJobs({
        jobType: "draft_generation",
        queuedBefore,
        errorMessage: "queued worker died",
      }),
    ).resolves.toBe(2);

    // SELECT for queued jobs older than threshold
    expect(queryMock).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("status = 'queued'"),
      ["draft_generation", queuedBefore],
    );
    expect(queryMock.mock.calls[0][0]).toContain("created_at < ?");

    // UPDATE jobs to failed (guarded by AND status = 'queued')
    expect(queryMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("SET status = 'failed'"),
      ["queued worker died", 187, 188],
    );
    expect(queryMock.mock.calls[1][0]).toContain("status = 'queued'");

    // Repair drafting source -> draft_ready when a ready draft exists
    expect(queryMock.mock.calls[2][0]).toContain("state = 'draft_ready'");
    expect(queryMock.mock.calls[2][1]).toEqual([254, 209]);

    // Repair drafting source -> needs_attention when no ready draft exists
    expect(queryMock.mock.calls[3][0]).toContain("state = 'needs_attention'");
    expect(queryMock.mock.calls[3][1]).toEqual([
      JSON.stringify(["generation_failed"]),
      "queued worker died",
      254,
      209,
    ]);
  });

  it("expireStaleQueuedProcessingJobs is a no-op when no queued jobs are stale", async () => {
    queryMock.mockResolvedValueOnce([[]]);

    await expect(
      repository().expireStaleQueuedProcessingJobs({
        jobType: "draft_generation",
        queuedBefore: new Date("2026-06-01T12:00:00.000Z"),
        errorMessage: "queued worker died",
      }),
    ).resolves.toBe(0);

    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("expires stale running processing jobs and repairs drafting source state", async () => {
    const staleStartedBefore = new Date("2026-06-01T12:00:00.000Z");
    queryMock
      .mockResolvedValueOnce([
        [
          { id: 187, source_id: 254 },
          { id: 188, source_id: 209 },
        ],
      ])
      .mockResolvedValueOnce([{ affectedRows: 2 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    await expect(
      repository().expireStaleProcessingJobs({
        jobType: "draft_generation",
        staleStartedBefore,
        errorMessage: "stale worker",
      }),
    ).resolves.toBe(2);

    expect(queryMock).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("started_at < ?"),
      ["draft_generation", staleStartedBefore],
    );
    expect(queryMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("SET status = 'failed'"),
      ["stale worker", 187, 188],
    );
    expect(queryMock.mock.calls[2][0]).toContain("state = 'draft_ready'");
    expect(queryMock.mock.calls[2][1]).toEqual([254, 209]);
    expect(queryMock.mock.calls[3][0]).toContain("state = 'needs_attention'");
    expect(queryMock.mock.calls[3][1]).toEqual([
      JSON.stringify(["generation_failed"]),
      "stale worker",
      254,
      209,
    ]);
  });

  it("completeProcessingJob only succeeds a still-running job and returns true when it landed", async () => {
    queryMock.mockResolvedValueOnce([{ affectedRows: 1 }]);

    await expect(repository().completeProcessingJob(42)).resolves.toBe(true);

    const [sql, params] = queryMock.mock.calls[0];
    expect(String(sql)).toContain("SET status = 'succeeded'");
    expect(String(sql)).toContain("status = 'running'");
    expect(params).toEqual([42]);
  });

  it("completeProcessingJob returns false when the job is no longer running (lost the race to the stale sweep)", async () => {
    queryMock.mockResolvedValueOnce([{ affectedRows: 0 }]);

    await expect(repository().completeProcessingJob(42)).resolves.toBe(false);
  });

  it("failProcessingJob only fails a still-running job and returns whether it landed", async () => {
    queryMock.mockResolvedValueOnce([{ affectedRows: 1 }]);

    await expect(repository().failProcessingJob(42, "boom")).resolves.toBe(
      true,
    );

    const [sql, params] = queryMock.mock.calls[0];
    expect(String(sql)).toContain("SET status = 'failed'");
    expect(String(sql)).toContain("status = 'running'");
    expect(params).toEqual(["boom", 42]);
  });

  it("failProcessingJob returns false when the job is no longer running", async () => {
    queryMock.mockResolvedValueOnce([{ affectedRows: 0 }]);

    await expect(repository().failProcessingJob(42, "boom")).resolves.toBe(
      false,
    );
  });

  it("summarizes processing job health by status and stale running jobs", async () => {
    const staleStartedBefore = new Date("2026-06-01T12:00:00.000Z");
    queryMock.mockResolvedValueOnce([
      [
        {
          status: "queued",
          count: "2",
          oldest_created_at: "2026-06-01T12:01:00.000Z",
          oldest_started_at: null,
          stale_running_count: null,
        },
        {
          status: "running",
          count: "3",
          oldest_created_at: "2026-06-01T11:00:00.000Z",
          oldest_started_at: "2026-06-01T11:30:00.000Z",
          stale_running_count: "1",
        },
        {
          status: "failed",
          count: 1,
          oldest_created_at: "2026-06-01T10:00:00.000Z",
          oldest_started_at: "2026-06-01T10:30:00.000Z",
          stale_running_count: "0",
        },
      ],
    ]);

    await expect(
      repository().getProcessingJobHealth({ staleStartedBefore }),
    ).resolves.toEqual({
      byStatus: { queued: 2, running: 3, succeeded: 0, failed: 1 },
      staleRunning: 1,
      oldestQueuedAt: "2026-06-01T12:01:00.000Z",
      oldestRunningAt: "2026-06-01T11:30:00.000Z",
    });

    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("stale_running_count"),
      [staleStartedBefore],
    );
  });

  it("lists recent source events with parsed metadata", async () => {
    queryMock.mockResolvedValueOnce([
      [
        {
          id: "701",
          source_id: "12",
          event_type: "draft_generation_queued",
          actor: "kkompalli",
          metadata_json: JSON.stringify({ jobId: 44 }),
          created_at: "2026-06-01T12:01:00.000Z",
        },
        {
          id: 700,
          source_id: 12,
          event_type: "source_archived",
          actor: null,
          metadata_json: "{not-json",
          created_at: "2026-06-01T12:00:00.000Z",
        },
      ],
    ]);

    await expect(repository().listSourceEvents(12, 500)).resolves.toEqual([
      {
        id: 701,
        sourceId: 12,
        eventType: "draft_generation_queued",
        actor: "kkompalli",
        metadata: { jobId: 44 },
        createdAt: "2026-06-01T12:01:00.000Z",
      },
      {
        id: 700,
        sourceId: 12,
        eventType: "source_archived",
        actor: null,
        metadata: null,
        createdAt: "2026-06-01T12:00:00.000Z",
      },
    ]);

    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("FROM spec_factory_events"),
      [12, 100],
    );
  });

  it("lists OneShot submission summaries with approved children", async () => {
    queryMock
      .mockResolvedValueOnce([
        [
          {
            id: 12,
            source_jira_key: "CPDEV-22410",
            source_summary: "Enrollment sync rules",
            source_status: "Done",
            loe_hours: "38.00",
            state: "oneshot_submitted",
            origin: "louise",
            approved_epic_key: "CPDEV-22411",
            updated_at: new Date("2026-05-27T12:00:00Z"),
          },
        ],
      ])
      .mockResolvedValueOnce([
        [
          childRow({
            source_id: 12,
            state: "oneshot_requested",
            oneshot_request_id: 701,
          }),
        ],
      ]);

    await expect(repository().listOneShotSubmissions()).resolves.toEqual([
      {
        source: expect.objectContaining({
          id: 12,
          state: "oneshot_submitted",
          origin: "louise",
          approvedEpicKey: "CPDEV-22411",
        }),
        childTickets: [
          expect.objectContaining({
            id: 99,
            state: "oneshot_requested",
            oneshotRequestId: 701,
          }),
        ],
      },
    ]);
    expect(queryMock.mock.calls[1][0]).toContain("MAX(latest.version)");
  });

  it("createComposeSource inserts a compose-origin source and returns its id", async () => {
    const query = vi
      .fn()
      // INSERT
      .mockResolvedValueOnce([{ insertId: 77, affectedRows: 1 }, []])
      // SELECT id (fallback path, not used when insertId present)
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

  it("createComposeSource resolves an existing source after a duplicate synthetic key", async () => {
    const duplicate = Object.assign(
      new Error(
        "Duplicate entry 'COMPOSE-5' for key 'uk_spec_factory_source_key'",
      ),
      { code: "ER_DUP_ENTRY" },
    );
    const query = vi
      .fn()
      .mockRejectedValueOnce(duplicate)
      .mockResolvedValueOnce([[{ id: 77 }], []]);
    const pool = { query, getConnection: vi.fn() };
    const repo = new SpecFactoryRepository(pool as never);

    await expect(
      repo.createComposeSource({
        sourceJiraKey: "COMPOSE-5",
        sourceSummary: "Brainstormed enrollment idea",
      }),
    ).resolves.toBe(77);

    expect(String(query.mock.calls[1][0])).toContain(
      "SELECT id FROM spec_factory_sources",
    );
  });

  it("getSourceOrigin returns compose for a compose row and louise otherwise", async () => {
    const composePool = {
      query: vi.fn().mockResolvedValue([[{ origin: "compose" }], []]),
      getConnection: vi.fn(),
    };
    const louisePool = {
      query: vi.fn().mockResolvedValue([[{ origin: "louise" }], []]),
      getConnection: vi.fn(),
    };
    const missingPool = {
      query: vi.fn().mockResolvedValue([[], []]),
      getConnection: vi.fn(),
    };

    expect(
      await new SpecFactoryRepository(composePool as never).getSourceOrigin(1),
    ).toBe("compose");
    expect(
      await new SpecFactoryRepository(louisePool as never).getSourceOrigin(1),
    ).toBe("louise");
    expect(
      await new SpecFactoryRepository(missingPool as never).getSourceOrigin(1),
    ).toBe("louise");
  });

  it("requeues a retryable publish stage while preserving workflow publishing state", async () => {
    const connection = transactionalConnection();
    connection.query
      .mockResolvedValueOnce([[{ attempt_count: 1, max_attempts: 3 }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);
    getConnectionMock.mockResolvedValue(connection);

    await expect(
      repository().failDraftStage({
        stageRun: {
          id: 11,
          workflowId: 7,
          sourceId: 5,
          handoffSnapshotId: 3,
          stageName: "jira_publish",
          stageOrder: 6,
          attemptCount: 1,
          leaseGeneration: 4,
          workerId: "draft-1",
          input: {},
          priorOutputs: {},
        },
        errorCode: "provider_unavailable",
        errorMessage: "503 unavailable",
        retryable: true,
        durationMs: 25,
      }),
    ).resolves.toBe(true);

    expect(String(connection.query.mock.calls[0][0])).toContain(
      "stage.lease_until >= CURRENT_TIMESTAMP(3)",
    );
    expect(String(connection.query.mock.calls[0][0])).toContain(
      "source.state <> 'archived'",
    );
    expect(connection.query.mock.calls[1][1]?.[0]).toBe("queued");
    expect(connection.query.mock.calls[2][1]?.[0]).toBe("publishing");
  });
});
