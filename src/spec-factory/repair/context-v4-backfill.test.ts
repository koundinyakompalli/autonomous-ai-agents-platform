import { describe, expect, it, vi } from "vitest";
import { ContextV4Backfill } from "./context-v4-backfill.js";

describe("ContextV4Backfill", () => {
  it("defaults to a non-mutating repair report", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([{ insertId: 9 }])
      .mockResolvedValueOnce([
        [{ id: 7, source_id: null, latest_context_version: 2 }],
      ])
      .mockResolvedValueOnce([{ insertId: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);
    const repository = {
      listSessionSources: vi.fn().mockResolvedValue([]),
      listMessages: vi.fn().mockResolvedValue([]),
    };
    const report = await new ContextV4Backfill(
      { query } as never,
      repository as never,
    ).run({ dryRun: true });
    expect(report).toMatchObject({
      repairRunId: 9,
      dryRun: true,
      inspected: 1,
      queued: 0,
      failed: 0,
    });
    expect(repository.listSessionSources).toHaveBeenCalledWith(7);
  });

  it("queues the handoff only after repair tasks settle and v4 context commits", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([
        [
          {
            id: 31,
            repair_run_id: 9,
            session_id: 7,
            source_id: 55,
            prior_context_version: 2,
            handoff_id: null,
            context_status: "clean",
            latest_context_version: 4,
          },
        ],
      ])
      .mockResolvedValueOnce([
        [
          {
            pending_repair_sources: 0,
            failed_repair_sources: 0,
            pending_context_merges: 0,
          },
        ],
      ])
      .mockResolvedValueOnce([[{ id: 88 }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([
        [
          {
            id: 9,
            repair_type: "context_rebuild_v4",
            status: "running",
            dry_run: 0,
            cursor_session_id: 7,
            inspected_count: 1,
            queued_count: 1,
            succeeded_count: 0,
            failed_count: 0,
          },
        ],
      ]);
    const repository = {
      createHandoffBuildTask: vi.fn().mockResolvedValue({
        handoffId: 44,
        agentTaskId: 45,
      }),
      enqueueContextMergeTaskIfNeeded: vi.fn(),
    };

    await expect(
      new ContextV4Backfill(
        { query } as never,
        repository as never,
      ).reconcile(),
    ).resolves.toEqual({
      inspected: 1,
      waiting: 0,
      handoffsQueued: 1,
      succeeded: 0,
      skipped: 0,
      failed: 0,
    });
    expect(repository.createHandoffBuildTask).toHaveBeenCalledWith({
      sessionId: 7,
      sourceId: 55,
      idempotencyKey: "context-rebuild-v4:7:4",
      requestedBy: "context-v4-backfill",
      reusedExistingSource: true,
    });
  });

  it("materializes revisions for converted legacy sources before distillation", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([{ insertId: 9 }])
      .mockResolvedValueOnce([
        [{ id: 7, source_id: null, latest_context_version: null }],
      ])
      .mockResolvedValueOnce([{ insertId: 31 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);
    const repository = {
      listSessionSources: vi.fn().mockResolvedValue([
        {
          id: 55,
          conversionStatus: "converted",
          currentRevisionId: null,
          markdownPath: "sources/legacy.md",
          markdownContent: "# Legacy source\n\nA preserved requirement.",
        },
      ]),
      listMessages: vi.fn().mockResolvedValue([]),
      completeSourceConversion: vi.fn().mockResolvedValue({
        sourceRevisionId: 101,
        chunkCount: 1,
      }),
      createAgentTask: vi.fn().mockResolvedValue(501),
      createReadyContextPatch: vi.fn().mockResolvedValue(502),
      enqueueContextMergeTaskIfNeeded: vi.fn().mockResolvedValue(502),
    };

    await expect(
      new ContextV4Backfill({ query } as never, repository as never).run({
        dryRun: false,
      }),
    ).resolves.toMatchObject({ queued: 1, failed: 0 });
    expect(repository.completeSourceConversion).toHaveBeenCalledWith({
      sourceId: 55,
      markdownPath: "sources/legacy.md",
      markdownContent: "# Legacy source\n\nA preserved requirement.",
    });
    expect(repository.createAgentTask).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          sourceId: 55,
          sourceRevisionId: 101,
          repair: "context_rebuild_v4",
        }),
      }),
    );
    expect(repository.createReadyContextPatch).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 7,
        patchKind: "repair",
        idempotencyKey: "context-rebuild-v4:baseline:7:0",
        messageIds: [],
      }),
    );
  });

  it("materializes a truthful DB revision for a legacy visual source with empty text", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([{ insertId: 9 }])
      .mockResolvedValueOnce([
        [{ id: 7, source_id: null, latest_context_version: null }],
      ])
      .mockResolvedValueOnce([{ insertId: 31 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);
    const repository = {
      listSessionSources: vi.fn().mockResolvedValue([
        {
          id: 55,
          conversionStatus: "converted",
          currentRevisionId: null,
          originalFilename: "workflow.png",
          mimeType: "image/png",
          sizeBytes: 2048,
          s3KeyRaw: "compose/7/raw/55-workflow.png",
          markdownPath: "/legacy/empty.png.md",
          markdownContent: "",
        },
      ]),
      listMessages: vi.fn().mockResolvedValue([]),
      completeSourceConversion: vi.fn().mockResolvedValue({
        sourceRevisionId: 101,
        chunkCount: 1,
      }),
      createAgentTask: vi.fn().mockResolvedValue(501),
      createReadyContextPatch: vi.fn().mockResolvedValue(502),
      enqueueContextMergeTaskIfNeeded: vi.fn().mockResolvedValue(502),
    };

    await expect(
      new ContextV4Backfill({ query } as never, repository as never).run({
        dryRun: false,
      }),
    ).resolves.toMatchObject({ queued: 1, failed: 0 });
    expect(repository.completeSourceConversion).toHaveBeenCalledWith({
      sourceId: 55,
      markdownPath: null,
      markdownContent: expect.stringMatching(
        /Visual source metadata[\s\S]*original uploaded image remains the authoritative evidence/i,
      ),
    });
  });

  it("reports a non-visual converted source with empty content during dry inventory", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([{ insertId: 9 }])
      .mockResolvedValueOnce([
        [{ id: 7, source_id: null, latest_context_version: null }],
      ])
      .mockResolvedValueOnce([{ insertId: 31 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);
    const repository = {
      listSessionSources: vi.fn().mockResolvedValue([
        {
          id: 55,
          conversionStatus: "converted",
          currentRevisionId: null,
          originalFilename: "empty.md",
          mimeType: "text/markdown",
          markdownContent: "",
        },
      ]),
      listMessages: vi.fn().mockResolvedValue([]),
    };

    await expect(
      new ContextV4Backfill({ query } as never, repository as never).run({
        dryRun: true,
      }),
    ).resolves.toMatchObject({
      inspected: 1,
      queued: 0,
      failed: 1,
      failures: [
        {
          sessionId: 7,
          error: "context_rebuild_source_content_missing:55",
        },
      ],
    });
  });

  it("skips a session archived while repair work was running", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([
        [
          {
            id: 31,
            repair_run_id: 9,
            session_id: 7,
            source_id: null,
            prior_context_version: 2,
            handoff_id: null,
            session_status: "archived",
            context_status: "dirty",
            latest_context_version: 2,
          },
        ],
      ])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([
        [
          {
            id: 9,
            repair_type: "context_rebuild_v4",
            status: "completed",
            dry_run: 0,
            cursor_session_id: 7,
            inspected_count: 1,
            queued_count: 1,
            succeeded_count: 0,
            failed_count: 0,
          },
        ],
      ])
      .mockResolvedValueOnce([
        [
          {
            id: 31,
            session_id: 7,
            source_id: null,
            status: "skipped",
            prior_context_version: 2,
            target_context_version: null,
            agent_task_id: null,
            handoff_id: null,
            details_json: null,
            error_code: "session_archived_during_repair",
            error_message: "Session was archived",
          },
        ],
      ])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    await expect(
      new ContextV4Backfill({ query } as never, {} as never).reconcile(),
    ).resolves.toEqual({
      inspected: 1,
      waiting: 0,
      handoffsQueued: 0,
      succeeded: 0,
      skipped: 1,
      failed: 0,
    });
    expect(String(query.mock.calls[1][0])).toContain("status = 'skipped'");
    expect(String(query.mock.calls[2][0])).toContain(
      "UPDATE spec_factory_repair_runs",
    );
    expect(String(query.mock.calls[5][0])).toContain("report_sha256 = ?");
    expect(query.mock.calls[5][1][0]).toMatch(/^[a-f0-9]{64}$/);
  });

  it("accepts only a completed, error-free applied repair run", async () => {
    const query = vi.fn().mockResolvedValue([{ affectedRows: 1 }]);
    await expect(
      new ContextV4Backfill({ query } as never, {} as never).acceptRun({
        repairRunId: 9,
        acceptedBy: "operator@example.com",
        note: "Validated active-session coverage",
      }),
    ).resolves.toBeUndefined();
    expect(String(query.mock.calls[0][0])).toContain("failed_count = 0");
    expect(String(query.mock.calls[0][0])).toContain(
      "report_sha256 IS NOT NULL",
    );
    expect(query.mock.calls[0][1]).toEqual([
      "operator@example.com",
      "Validated active-session coverage",
      9,
    ]);
  });
});
