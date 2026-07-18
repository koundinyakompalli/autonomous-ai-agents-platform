import { describe, expect, it, vi } from "vitest";
import { ComposeRepository } from "./compose-database.js";
import { IdempotencyConflictError } from "./errors.js";
import { runWithSpecFactoryCorrelation } from "./telemetry/correlation.js";

function transactionalConnection() {
  return {
    query: vi.fn(),
    beginTransaction: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    release: vi.fn(),
  };
}

describe("ComposeRepository", () => {
  it("createSession inserts and returns the session id", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([{ insertId: 3, affectedRows: 1 }, []]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);

    const id = await repo.createSession({
      name: "Billing export",
      createdBy: "kompallik",
      createdByDisplay: "Koundinya",
      s3Prefix: "compose/3/",
      workspacePath: "/mnt/efs/spec-factory/compose/3",
      passwordHash: "scrypt:v1:salt:hash",
    });

    expect(id).toBe(3);
    expect(String(query.mock.calls[0][0])).toContain(
      "INSERT INTO compose_sessions",
    );
    expect(String(query.mock.calls[0][0])).toContain("password_hash");
    expect(query.mock.calls[0][1]).toContain("scrypt:v1:salt:hash");
  });

  it("listSessions hides archived rows and maps passwordProtected", async () => {
    const query = vi.fn().mockResolvedValueOnce([
      [
        {
          id: 3,
          name: "Billing export",
          created_by: null,
          created_by_display: null,
          status: "draft",
          claude_session_id: null,
          source_id: null,
          readiness_json: null,
          s3_prefix: "compose/3/",
          workspace_path: "/mnt/efs/spec-factory/compose/3",
          password_hash: "scrypt:v1:salt:hash",
          source_count: 2,
          created_at: "2026-06-02T00:00:00.000Z",
          updated_at: "2026-06-02T00:00:00.000Z",
        },
      ],
      [],
    ]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);

    const rows = await repo.listSessions();

    expect(rows[0].passwordProtected).toBe(true);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("password_hash");
    expect(sql).toContain("s.status <> 'archived'");
  });

  it("listSessions maps persisted agent persona and activity metadata", async () => {
    const query = vi.fn().mockResolvedValueOnce([
      [
        {
          id: 3,
          name: "Billing export",
          created_by: "kompallik",
          created_by_display: "Koundinya",
          status: "draft",
          archived_at: null,
          claude_session_id: null,
          source_id: null,
          readiness_json: null,
          agent_persona_key: "sage",
          agent_persona_name: "Sage",
          last_active_at: "2026-06-30T14:20:00.000Z",
          last_action: "analyze_started",
          last_actor: "kompallik",
          active_turn_started_at: "2026-06-30T14:19:00.000Z",
          s3_prefix: "compose/3/",
          workspace_path: "/mnt/efs/spec-factory/compose/3",
          password_hash: null,
          source_count: 2,
          created_at: "2026-06-02T00:00:00.000Z",
          updated_at: "2026-06-30T14:20:00.000Z",
        },
      ],
      [],
    ]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);

    const rows = await repo.listSessions();

    expect(rows[0]).toMatchObject({
      agentPersonaKey: "sage",
      agentPersonaName: "Sage",
      lastActiveAt: "2026-06-30T14:20:00.000Z",
      lastAction: "analyze_started",
      lastActor: "kompallik",
      analysisRunning: true,
    });
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("agent_persona_key");
    expect(sql).toContain("active_turn_started_at");
  });

  it("listSessions preserves readiness details", async () => {
    const query = vi.fn().mockResolvedValueOnce([
      [
        {
          id: 3,
          name: "Billing export",
          created_by: null,
          created_by_display: null,
          status: "ready",
          claude_session_id: null,
          source_id: null,
          readiness_json: JSON.stringify({
            ready: true,
            openQuestions: [],
            summary: "Ready.",
            details: {
              module: "Platform",
              repositories: ["core-app", "interop"],
              difficulty: "M",
              loeHours: 24,
              storyPoints: 5,
            },
          }),
          s3_prefix: "compose/3/",
          workspace_path: "/mnt/efs/spec-factory/compose/3",
          password_hash: null,
          source_count: 2,
          created_at: "2026-06-02T00:00:00.000Z",
          updated_at: "2026-06-02T00:00:00.000Z",
        },
      ],
      [],
    ]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);

    const rows = await repo.listSessions();

    expect(rows[0].readiness?.details).toMatchObject({
      module: "Platform",
      repositories: ["core-app", "interop"],
      difficulty: "M",
      loeHours: 24,
      storyPoints: 5,
    });
  });

  it("listSessionSources maps source intelligence fields", async () => {
    const query = vi.fn().mockResolvedValueOnce([
      [
        {
          id: 12,
          session_id: 3,
          kind: "jira",
          original_filename: "CPDEV-123 Medical Appeals",
          mime_type: null,
          size_bytes: null,
          source_url: "https://jira.example/browse/CPDEV-123",
          s3_key_raw: null,
          converter: "none",
          markdown_path: null,
          markdown_content: "# CPDEV-123\nRepo: core-app",
          source_summary: "Appeals case creation requirement.",
          source_entities_json: JSON.stringify({
            jiraKeys: ["CPDEV-123"],
            repositories: ["core-app"],
            files: ["AppealsController.java"],
            clients: ["BCBSRI"],
            loeHours: [24],
            dates: ["2026-06-30"],
            assumptions: ["Queue already exists."],
          }),
          source_usefulness: "high_signal",
          source_contribution: "Defines appeal creation scope and repo.",
          conversion_status: "converted",
          conversion_started_at: null,
          conversion_attempts: 1,
          conversion_lease_expires_at: null,
          error_message: null,
          created_at: "2026-06-02T00:00:00.000Z",
          updated_at: "2026-06-02T00:00:00.000Z",
        },
      ],
      [],
    ]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);

    const sources = await repo.listSessionSources(3);

    expect(sources[0]).toMatchObject({
      sourceSummary: "Appeals case creation requirement.",
      sourceUsefulness: "high_signal",
      sourceContribution: "Defines appeal creation scope and repo.",
      sourceEntities: {
        jiraKeys: ["CPDEV-123"],
        repositories: ["core-app"],
        files: ["AppealsController.java"],
        clients: ["BCBSRI"],
        loeHours: [24],
        dates: ["2026-06-30"],
        assumptions: ["Queue already exists."],
      },
    });
    expect(String(query.mock.calls[0][0])).toContain("source_entities_json");
  });

  it("getSession preserves repoEvidence and codeInvestigation from readiness_json", async () => {
    const query = vi.fn().mockResolvedValueOnce([
      [
        {
          id: 24,
          name: "Medical Appeals",
          created_by: null,
          created_by_display: null,
          status: "ready",
          claude_session_id: null,
          source_id: null,
          readiness_json: JSON.stringify({
            ready: true,
            openQuestions: ["q1"],
            summary: "Ready.",
            repoEvidence: [
              {
                repoName: "core-app",
                headSha: "b83cdc2",
                techStack: "Java",
                inspectedPaths: ["App.java"],
                keyMatches: [],
                warnings: [],
              },
            ],
            codeInvestigation: { filesRead: 6, toolCalls: 15 },
          }),
          s3_prefix: "compose/24/",
          workspace_path: "/mnt/efs/spec-factory/compose/24",
          password_hash: null,
          source_count: 2,
          created_at: "2026-06-17T00:00:00.000Z",
          updated_at: "2026-06-17T00:00:00.000Z",
        },
      ],
      [],
    ]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);

    const session = await repo.getSession(24);

    expect(session?.readiness?.repoEvidence).toHaveLength(1);
    expect(session?.readiness?.repoEvidence?.[0]).toMatchObject({
      repoName: "core-app",
      techStack: "Java",
    });
    expect(session?.readiness?.codeInvestigation).toEqual({
      filesRead: 6,
      toolCalls: 15,
    });
  });

  it("getSession exposes the latest context pointer for coordinator turns", async () => {
    const query = vi.fn().mockResolvedValueOnce([
      [
        {
          id: 26,
          name: "Coordinator context",
          created_by: null,
          created_by_display: null,
          status: "draft",
          claude_session_id: null,
          source_id: null,
          readiness_json: null,
          latest_context_version: 9,
          context_status: "clean",
          s3_prefix: "compose/26/",
          workspace_path: "/mnt/efs/spec-factory/compose/26",
          password_hash: null,
          source_count: 3,
          created_at: "2026-06-19T00:00:00.000Z",
          updated_at: "2026-06-19T00:00:00.000Z",
        },
      ],
      [],
    ]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);

    const session = await repo.getSession(26);

    expect(String(query.mock.calls[0][0])).toContain(
      "s.latest_context_version",
    );
    expect(String(query.mock.calls[0][0])).toContain("s.context_status");
    expect(session).toMatchObject({
      latestContextVersion: 9,
      contextStatus: "clean",
    });
  });

  it("getSession preserves stories, questions, ideating, and problem from readiness_json", async () => {
    const query = vi.fn().mockResolvedValueOnce([
      [
        {
          id: 25,
          name: "Guided QA",
          created_by: null,
          created_by_display: null,
          status: "draft",
          claude_session_id: null,
          source_id: null,
          readiness_json: JSON.stringify({
            ready: false,
            openQuestions: [
              "Which member groups need this workflow?",
              "Should we reuse the existing token method?",
            ],
            summary: "s",
            ideating: "Shaping the guided Q&A flow.",
            problem: "Operators lose agreed stories at handoff.",
            questions: [
              {
                id: "q-1",
                question: "Which member groups need this workflow?",
                options: ["All members", "Medicare only", "Commercial only"],
                questionType: "functional",
                answered: false,
              },
              {
                id: "q-technical",
                question: "Should we reuse the existing token method?",
                questionType: "implementation",
                answered: false,
              },
            ],
            stories: [
              {
                id: "story-1",
                title: "Token plumbing",
                summary: "Send token on protected reads",
                repos: ["dashboard"],
                sequence: 1,
              },
            ],
          }),
          s3_prefix: "compose/25/",
          workspace_path: "/mnt/efs/spec-factory/compose/25",
          password_hash: null,
          source_count: 1,
          created_at: "2026-06-18T00:00:00.000Z",
          updated_at: "2026-06-18T00:00:00.000Z",
        },
      ],
      [],
    ]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);

    const session = await repo.getSession(25);

    expect(session?.readiness?.ideating).toBe("Shaping the guided Q&A flow.");
    expect(session?.readiness?.problem).toBe(
      "Operators lose agreed stories at handoff.",
    );
    expect(session?.readiness?.questions).toHaveLength(1);
    expect(session?.readiness?.questions?.[0]).toMatchObject({
      id: "q-1",
      question: "Which member groups need this workflow?",
      options: ["All members", "Medicare only", "Commercial only"],
    });
    expect(session?.readiness?.openQuestions).toEqual([
      "Which member groups need this workflow?",
    ]);
    expect(session?.readiness?.stories).toHaveLength(1);
    expect(session?.readiness?.stories?.[0]).toMatchObject({
      id: "story-1",
      title: "Token plumbing",
      sequence: 1,
    });
  });

  it("getSessionPasswordHash returns the stored password hash", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([[{ password_hash: "scrypt:v1:salt:hash" }], []]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);

    await expect(repo.getSessionPasswordHash(3)).resolves.toBe(
      "scrypt:v1:salt:hash",
    );
    expect(String(query.mock.calls[0][0])).toContain("password_hash");
    expect(query.mock.calls[0][1]).toEqual([3]);
  });

  it("archiveSessionWithWorkCancellation cancels active turns and tasks atomically", async () => {
    const connection = transactionalConnection();
    connection.query
      .mockResolvedValueOnce([[{ id: 3 }], []])
      .mockResolvedValueOnce([[{ id: 101 }, { id: 102 }], []])
      .mockResolvedValueOnce([{ affectedRows: 2 }, []])
      .mockResolvedValueOnce([[{ id: 501 }], []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(repo.archiveSessionWithWorkCancellation(3)).resolves.toEqual({
      archived: true,
      cancelledTurnJobIds: [101, 102],
      cancelledAgentTaskIds: [501],
    });

    expect(connection.beginTransaction).toHaveBeenCalledOnce();
    expect(String(connection.query.mock.calls[0][0])).toContain(
      "FROM compose_sessions",
    );
    expect(String(connection.query.mock.calls[0][0])).toContain("FOR UPDATE");
    expect(String(connection.query.mock.calls[1][0])).toContain(
      "FROM compose_turn_jobs",
    );
    expect(String(connection.query.mock.calls[2][0])).toContain(
      "UPDATE compose_turn_jobs",
    );
    expect(String(connection.query.mock.calls[2][0])).toContain(
      "status = 'cancelled'",
    );
    expect(String(connection.query.mock.calls[2][0])).toContain(
      "active_worker_id = NULL",
    );
    expect(String(connection.query.mock.calls[3][0])).toContain(
      "FROM compose_agent_tasks",
    );
    expect(String(connection.query.mock.calls[4][0])).toContain(
      "UPDATE compose_agent_tasks",
    );
    expect(String(connection.query.mock.calls[5][0])).toContain(
      "UPDATE compose_sessions",
    );
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledOnce();
  });

  it("cancelTurnJob cancels a non-terminal turn and its active agent tasks", async () => {
    const connection = transactionalConnection();
    connection.query
      .mockResolvedValueOnce([[{ id: 101, status: "running" }], []])
      .mockResolvedValueOnce([[{ id: 501 }], []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(
      repo.cancelTurnJob({ sessionId: 3, turnJobId: 101 }),
    ).resolves.toEqual({
      cancelled: true,
      cancelledAgentTaskIds: [501],
      status: "cancelled",
    });

    expect(connection.beginTransaction).toHaveBeenCalledOnce();
    expect(String(connection.query.mock.calls[0][0])).toContain(
      "FROM compose_turn_jobs",
    );
    expect(String(connection.query.mock.calls[0][0])).toContain("FOR UPDATE");
    expect(connection.query.mock.calls[0][1]).toEqual([101, 3]);
    expect(String(connection.query.mock.calls[1][0])).toContain(
      "FROM compose_agent_tasks",
    );
    expect(String(connection.query.mock.calls[2][0])).toContain(
      "UPDATE compose_agent_tasks",
    );
    expect(String(connection.query.mock.calls[3][0])).toContain(
      "UPDATE compose_turn_jobs",
    );
    expect(String(connection.query.mock.calls[3][0])).toContain(
      "status = 'cancelled'",
    );
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledOnce();
  });

  it("recordSessionActivity persists actor, action, and active turn state", async () => {
    const query = vi.fn().mockResolvedValue([{ affectedRows: 1 }, []]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);

    await repo.recordSessionActivity({
      sessionId: 3,
      action: "analyze_started",
      actor: "kompallik",
      activeTurn: "started",
    });
    await repo.recordSessionActivity({
      sessionId: 3,
      action: "analyze_completed",
      actor: "kompallik",
      activeTurn: "finished",
    });

    expect(String(query.mock.calls[0][0])).toContain(
      "active_turn_started_at = CURRENT_TIMESTAMP(3)",
    );
    expect(String(query.mock.calls[0][0])).toContain("status <> 'archived'");
    expect(query.mock.calls[0][1]).toEqual(["analyze_started", "kompallik", 3]);
    expect(String(query.mock.calls[1][0])).toContain(
      "active_turn_started_at = NULL",
    );
    expect(String(query.mock.calls[1][0])).toContain("status <> 'archived'");
    expect(query.mock.calls[1][1]).toEqual([
      "analyze_completed",
      "kompallik",
      3,
    ]);
  });

  it("appendSessionEvent stores bounded replayable session events", async () => {
    const connection = transactionalConnection();
    connection.query
      .mockResolvedValueOnce([{ insertId: 91, affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ insertId: 301, affectedRows: 1 }, []]);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(
      repo.appendSessionEvent({
        sessionId: 7,
        eventType: "turn.status",
        payload: { type: "status", status: "thinking", message: "Reading" },
        actorType: "system",
        actorId: "spec-factory-operator",
      }),
    ).resolves.toMatchObject({
      id: 91,
      sessionId: 7,
      eventType: "turn.status",
      payload: { type: "status", status: "thinking", message: "Reading" },
    });

    const sql = String(connection.query.mock.calls[0][0]);
    expect(sql).toContain("INSERT INTO compose_session_events");
    expect(sql).toContain("payload_bytes");
    expect(connection.query.mock.calls[0][1]).toEqual([
      7,
      "turn.status",
      null,
      JSON.stringify({
        type: "status",
        status: "thinking",
        message: "Reading",
      }),
      57,
      "system",
      "spec-factory-operator",
      null,
      null,
      null,
      null,
      7,
      "turn.status",
    ]);
    expect(String(connection.query.mock.calls[1][0])).toContain(
      "INSERT INTO spec_factory_outbox",
    );
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.release).toHaveBeenCalledOnce();
  });

  it("appendSessionEvent skips archived sessions", async () => {
    const connection = transactionalConnection();
    connection.query.mockResolvedValueOnce([
      { insertId: 0, affectedRows: 0 },
      [],
    ]);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(
      repo.appendSessionEvent({
        sessionId: 7,
        eventType: "turn.status",
        payload: { type: "status", status: "thinking", message: "Reading" },
      }),
    ).resolves.toBeNull();

    const sql = String(connection.query.mock.calls[0][0]);
    expect(sql).toContain("INSERT INTO compose_session_events");
    expect(sql).toContain("FROM compose_sessions");
    expect(sql).toContain("status <> 'archived'");
    expect(connection.query).toHaveBeenCalledTimes(1);
    expect(connection.commit).toHaveBeenCalledOnce();
  });

  it("appendSessionEvent permits terminal archive-related events", async () => {
    const connection = transactionalConnection();
    connection.query
      .mockResolvedValueOnce([{ insertId: 92, affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ insertId: 302, affectedRows: 1 }, []]);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(
      repo.appendSessionEvent({
        sessionId: 7,
        eventType: "session.archived",
        payload: { type: "session", status: "archived" } as never,
      }),
    ).resolves.toMatchObject({
      id: 92,
      eventType: "session.archived",
    });

    const sql = String(connection.query.mock.calls[0][0]);
    expect(sql).toContain("IN (");
    expect(sql).toContain("'session.archived'");
    expect(sql).toContain("'turn.cancelling'");
    expect(sql).toContain("'turn.cancelled'");
    expect(sql).toContain("'task.cancelled'");
    expect(sql).toContain("'turn.lease_fence_rejected'");
    expect(sql).toContain("'task.lease_fence_rejected'");
    expect(connection.query.mock.calls[0][1]).toContain("session.archived");
  });

  it("appendSessionEvent rejects payloads larger than 16KB", async () => {
    const query = vi.fn();
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);

    await expect(
      repo.appendSessionEvent({
        sessionId: 7,
        eventType: "turn.status",
        payload: { type: "status", message: "x".repeat(16 * 1024) },
      }),
    ).rejects.toThrow(/payload/i);
    expect(query).not.toHaveBeenCalled();
  });

  it("listSessionEventsAfter replays events ordered by durable id", async () => {
    const query = vi.fn().mockResolvedValueOnce([
      [
        {
          id: 91,
          session_id: 7,
          event_type: "turn.status",
          sequence: null,
          payload_json: JSON.stringify({ type: "status", status: "thinking" }),
          payload_bytes: 37,
          actor_type: "system",
          actor_id: "spec-factory-operator",
          turn_job_id: null,
          agent_task_id: null,
          context_version: null,
          created_at: new Date("2026-07-05T10:00:00.000Z"),
        },
      ],
      [],
    ]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);

    await expect(repo.listSessionEventsAfter(7, 90)).resolves.toEqual([
      {
        id: 91,
        sessionId: 7,
        eventType: "turn.status",
        sequence: null,
        payload: { type: "status", status: "thinking" },
        payloadBytes: 37,
        actorType: "system",
        actorId: "spec-factory-operator",
        turnJobId: null,
        agentTaskId: null,
        contextVersion: null,
        createdAt: "2026-07-05T10:00:00.000Z",
      },
    ]);
    expect(String(query.mock.calls[0][0])).toContain("id > ?");
    expect(String(query.mock.calls[0][0])).toContain("ORDER BY id ASC");
    expect(query.mock.calls[0][1]).toEqual([7, 90, 100]);
  });

  it("gets the durable event high-water mark for a session", async () => {
    const query = vi.fn().mockResolvedValueOnce([[{ id: "912" }], []]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);

    await expect(repo.getLatestSessionEventId(7)).resolves.toBe(912);
    expect(String(query.mock.calls[0][0])).toContain("MAX(id)");
    expect(String(query.mock.calls[0][0])).toContain(
      "FROM compose_session_events",
    );
    expect(query.mock.calls[0][1]).toEqual([7]);
  });

  it("batches durable event replay by per-session cursors", async () => {
    const query = vi.fn().mockResolvedValueOnce([[], []]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);

    await expect(
      repo.listSessionEventsForCursors([
        { sessionId: 7, afterEventId: 90 },
        { sessionId: 8, afterEventId: 120 },
      ]),
    ).resolves.toEqual([]);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("UNION ALL");
    expect(sql).toContain("event.id > session_cursor.after_event_id");
    expect(query.mock.calls[0][1]).toEqual([7, 90, 8, 120, 5000]);
  });

  it("createStreamToken stores a hashed stream token with expiry", async () => {
    const query = vi.fn().mockResolvedValueOnce([{ affectedRows: 1 }, []]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);
    const expiresAt = new Date("2026-07-05T10:30:00.000Z");

    await repo.createStreamToken({
      tokenHash: "a".repeat(64),
      sessionId: 7,
      expiresAt,
    });

    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("INSERT INTO compose_stream_tokens");
    expect(sql).toContain("token_hash");
    expect(query.mock.calls[0][1]).toEqual(["a".repeat(64), 7, expiresAt]);
  });

  it("verifyStreamTokenHash accepts only active unexpired unrevoked tokens", async () => {
    const query = vi.fn().mockResolvedValueOnce([{ affectedRows: 1 }, []]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);

    await expect(
      repo.verifyStreamTokenHash({
        tokenHash: "b".repeat(64),
        sessionId: 7,
      }),
    ).resolves.toBe(true);

    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("UPDATE compose_stream_tokens");
    expect(sql).toContain("revoked_at IS NULL");
    expect(sql).toContain("expires_at > CURRENT_TIMESTAMP(3)");
    expect(query.mock.calls[0][1]).toEqual(["b".repeat(64), 7]);
  });

  it("revokeSessionStreamTokens revokes all active tokens for a session", async () => {
    const query = vi.fn().mockResolvedValueOnce([{ affectedRows: 2 }, []]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);

    await expect(repo.revokeSessionStreamTokens(7)).resolves.toBe(2);

    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("UPDATE compose_stream_tokens");
    expect(sql).toContain("revoked_at = CURRENT_TIMESTAMP(3)");
    expect(sql).toContain("session_id = ?");
    expect(sql).toContain("revoked_at IS NULL");
    expect(query.mock.calls[0][1]).toEqual([7]);
  });

  it("purgeExpiredStreamTokens deletes expired token rows in bounded order", async () => {
    const query = vi.fn().mockResolvedValueOnce([{ affectedRows: 4 }, []]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);
    const expiredBefore = new Date("2026-07-05T10:00:00.000Z");

    await expect(
      repo.purgeExpiredStreamTokens({ expiredBefore, limit: 25 }),
    ).resolves.toBe(4);

    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("DELETE FROM compose_stream_tokens");
    expect(sql).toContain("expires_at < ?");
    expect(sql).toContain("ORDER BY expires_at ASC");
    expect(sql).toContain("LIMIT ?");
    expect(query.mock.calls[0][1]).toEqual([expiredBefore, 25]);
  });

  it("purgeStaleWorkerHeartbeats deletes old heartbeat rows in bounded order", async () => {
    const query = vi.fn().mockResolvedValueOnce([{ affectedRows: 7 }, []]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);
    const heartbeatBefore = new Date("2026-07-01T00:00:00.000Z");

    await expect(
      repo.purgeStaleWorkerHeartbeats({ heartbeatBefore, limit: 25 }),
    ).resolves.toBe(7);

    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("DELETE FROM spec_factory_worker_heartbeats");
    expect(sql).toContain("heartbeat_at < ?");
    expect(sql).toContain("ORDER BY heartbeat_at ASC");
    expect(sql).toContain("LIMIT ?");
    expect(query.mock.calls[0][1]).toEqual([heartbeatBefore, 25]);
  });

  it("upsertWorkspaceManifest persists the latest active-session workspace manifest", async () => {
    const query = vi.fn().mockResolvedValueOnce([{ affectedRows: 2 }, []]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);

    await repo.upsertWorkspaceManifest({
      sessionId: 7,
      workspacePath: "/workspaces/compose/7",
      manifestJson: { manifestVersion: 1, sessionId: 7 },
      manifestBytes: 42,
      manifestSha256:
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });

    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("INSERT INTO compose_workspace_manifests");
    expect(sql).toContain("FROM compose_sessions");
    expect(sql).toContain("status <> 'archived'");
    expect(sql).toContain("ON DUPLICATE KEY UPDATE");
    expect(query.mock.calls[0][1]).toEqual([
      7,
      "/workspaces/compose/7",
      JSON.stringify({ manifestVersion: 1, sessionId: 7 }),
      42,
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      7,
    ]);
  });

  it("upsertWorkspaceManifest rejects archived or missing sessions", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([{ affectedRows: 0 }, []])
      .mockResolvedValueOnce([[], []]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);

    await expect(
      repo.upsertWorkspaceManifest({
        sessionId: 7,
        workspacePath: "/workspaces/compose/7",
        manifestJson: { manifestVersion: 1, sessionId: 7 },
        manifestBytes: 42,
        manifestSha256:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    ).rejects.toThrow("Compose session 7 was not found");
  });

  it("upsertWorkspaceManifest accepts a duplicate no-op for an active session", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([{ affectedRows: 0 }, []])
      .mockResolvedValueOnce([[{ id: 7 }], []]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);

    await expect(
      repo.upsertWorkspaceManifest({
        sessionId: 7,
        workspacePath: "/workspaces/compose/7",
        manifestJson: { manifestVersion: 1, sessionId: 7 },
        manifestBytes: 42,
        manifestSha256:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    ).resolves.toBeUndefined();

    expect(String(query.mock.calls[1][0])).toContain("status <> 'archived'");
    expect(query.mock.calls[1][1]).toEqual([7]);
  });

  it("createMessageTurn inserts the user message and turn job in one transaction", async () => {
    const connection = transactionalConnection();
    connection.query
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([[{ id: 7, latest_context_version: 4 }], []])
      .mockResolvedValueOnce([{ insertId: 51 }, []])
      .mockResolvedValueOnce([{ insertId: 101 }, []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]);
    const getConnection = vi.fn().mockResolvedValueOnce(connection);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection,
    } as never);

    await expect(
      repo.createMessageTurn({
        sessionId: 7,
        content: "Use medhok-monorepo",
        idempotencyKey: "msg-abc",
        requestHash: "c".repeat(64),
      }),
    ).resolves.toEqual({
      turnJobId: 101,
      messageId: 51,
      status: "queued",
      deduplicated: false,
    });

    expect(connection.beginTransaction).toHaveBeenCalledOnce();
    expect(String(connection.query.mock.calls[0][0])).not.toContain(
      "FOR UPDATE",
    );
    expect(connection.query.mock.calls[0][1]).toEqual([7, "msg-abc"]);
    expect(String(connection.query.mock.calls[1][0])).toContain("FOR UPDATE");
    expect(connection.query.mock.calls[1][1]).toEqual([7]);
    expect(String(connection.query.mock.calls[2][0])).toContain(
      "INSERT INTO compose_session_messages",
    );
    expect(connection.query.mock.calls[2][1]).toEqual([
      7,
      "user",
      "Use medhok-monorepo",
      "user",
    ]);
    expect(String(connection.query.mock.calls[3][0])).toContain(
      "INSERT INTO compose_turn_jobs",
    );
    expect(connection.query.mock.calls[3][1]).toEqual([
      7,
      "chat",
      51,
      4,
      "msg-abc",
      "c".repeat(64),
      null,
    ]);
    expect(String(connection.query.mock.calls[4][0])).toContain(
      "turn_job_id = ?",
    );
    expect(connection.query.mock.calls[4][1]).toEqual([101, 51]);
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledOnce();
  });

  it("createMessageTurn returns an existing matching idempotency key without inserting", async () => {
    const connection = transactionalConnection();
    connection.query.mockResolvedValueOnce([
      [
        {
          id: 101,
          user_message_id: 51,
          status: "queued",
          request_hash: "d".repeat(64),
        },
      ],
      [],
    ]);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(
      repo.createMessageTurn({
        sessionId: 7,
        content: "Use medhok-monorepo",
        idempotencyKey: "msg-abc",
        requestHash: "d".repeat(64),
      }),
    ).resolves.toEqual({
      turnJobId: 101,
      messageId: 51,
      status: "queued",
      deduplicated: true,
    });

    expect(connection.query).toHaveBeenCalledTimes(1);
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.rollback).not.toHaveBeenCalled();
  });

  it("createMessageTurn rejects reused idempotency keys with a different request hash", async () => {
    const connection = transactionalConnection();
    connection.query.mockResolvedValueOnce([
      [
        {
          id: 101,
          user_message_id: 51,
          status: "queued",
          request_hash: "e".repeat(64),
        },
      ],
      [],
    ]);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(
      repo.createMessageTurn({
        sessionId: 7,
        content: "Different request",
        idempotencyKey: "msg-abc",
        requestHash: "f".repeat(64),
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);

    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.rollback).toHaveBeenCalledOnce();
  });

  it("createMessageTurn re-reads the winner after a duplicate-key insert race", async () => {
    const duplicateKey = Object.assign(new Error("Duplicate entry"), {
      code: "ER_DUP_ENTRY",
      errno: 1062,
    });
    const connection = transactionalConnection();
    connection.query
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([[{ id: 7, latest_context_version: 4 }], []])
      .mockResolvedValueOnce([{ insertId: 51 }, []])
      .mockRejectedValueOnce(duplicateKey)
      .mockResolvedValueOnce([
        [
          {
            id: 101,
            user_message_id: 52,
            status: "queued",
            request_hash: "g".repeat(64),
          },
        ],
        [],
      ]);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(
      repo.createMessageTurn({
        sessionId: 7,
        content: "Use medhok-monorepo",
        idempotencyKey: "msg-abc",
        requestHash: "g".repeat(64),
      }),
    ).resolves.toEqual({
      turnJobId: 101,
      messageId: 52,
      status: "queued",
      deduplicated: true,
    });

    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(connection.commit).not.toHaveBeenCalled();
    expect(String(connection.query.mock.calls[4][0])).toContain(
      "idempotency_key",
    );
  });

  it("createMessageTurn retries a deadlocked transaction once", async () => {
    const deadlock = Object.assign(new Error("Deadlock found"), {
      code: "ER_LOCK_DEADLOCK",
      errno: 1213,
    });
    const first = transactionalConnection();
    first.query
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([[{ id: 7, latest_context_version: 4 }], []])
      .mockResolvedValueOnce([{ insertId: 51 }, []])
      .mockRejectedValueOnce(deadlock);
    const second = transactionalConnection();
    second.query
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([[{ id: 7, latest_context_version: 4 }], []])
      .mockResolvedValueOnce([{ insertId: 52 }, []])
      .mockResolvedValueOnce([{ insertId: 101 }, []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]);
    const getConnection = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection,
    } as never);

    await expect(
      repo.createMessageTurn({
        sessionId: 7,
        content: "Use medhok-monorepo",
        idempotencyKey: "msg-deadlock",
        requestHash: "h".repeat(64),
      }),
    ).resolves.toEqual({
      turnJobId: 101,
      messageId: 52,
      status: "queued",
      deduplicated: false,
    });

    expect(getConnection).toHaveBeenCalledTimes(2);
    expect(first.rollback).toHaveBeenCalledOnce();
    expect(first.release).toHaveBeenCalledOnce();
    expect(second.commit).toHaveBeenCalledOnce();
  });

  it("createAnalyzeTurn stores a nullable-message analyze job", async () => {
    const connection = transactionalConnection();
    connection.query
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([[{ id: 7, latest_context_version: 4 }], []])
      .mockResolvedValueOnce([{ insertId: 102 }, []]);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(
      repo.createAnalyzeTurn({
        sessionId: 7,
        idempotencyKey: "analyze-abc",
        requestHash: "a".repeat(64),
      }),
    ).resolves.toEqual({
      turnJobId: 102,
      messageId: null,
      status: "queued",
      deduplicated: false,
    });

    expect(String(connection.query.mock.calls[2][0])).toContain(
      "INSERT INTO compose_turn_jobs",
    );
    expect(connection.query.mock.calls[2][1]).toEqual([
      7,
      "analyze",
      null,
      4,
      "analyze-abc",
      "a".repeat(64),
      null,
    ]);
    expect(connection.commit).toHaveBeenCalledOnce();
  });

  it("createAnalyzeTurn rejects reused idempotency keys with a different request hash", async () => {
    const connection = transactionalConnection();
    connection.query.mockResolvedValueOnce([
      [
        {
          id: 102,
          user_message_id: null,
          status: "queued",
          request_hash: "b".repeat(64),
        },
      ],
      [],
    ]);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(
      repo.createAnalyzeTurn({
        sessionId: 7,
        idempotencyKey: "analyze-abc",
        requestHash: "c".repeat(64),
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);

    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.rollback).toHaveBeenCalledOnce();
  });

  it("createAnalyzeTurn re-reads the winner after a duplicate-key insert race", async () => {
    const duplicateKey = Object.assign(new Error("Duplicate entry"), {
      code: "ER_DUP_ENTRY",
      errno: 1062,
    });
    const connection = transactionalConnection();
    connection.query
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([[{ id: 7, latest_context_version: 4 }], []])
      .mockRejectedValueOnce(duplicateKey)
      .mockResolvedValueOnce([
        [
          {
            id: 102,
            user_message_id: null,
            status: "queued",
            request_hash: "e".repeat(64),
          },
        ],
        [],
      ]);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(
      repo.createAnalyzeTurn({
        sessionId: 7,
        idempotencyKey: "analyze-abc",
        requestHash: "e".repeat(64),
      }),
    ).resolves.toEqual({
      turnJobId: 102,
      messageId: null,
      status: "queued",
      deduplicated: true,
    });

    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(connection.commit).not.toHaveBeenCalled();
    expect(String(connection.query.mock.calls[3][0])).toContain(
      "idempotency_key",
    );
  });

  it("createAnalyzeTurn retries a deadlocked transaction once", async () => {
    const deadlock = Object.assign(new Error("Deadlock found"), {
      code: "ER_LOCK_DEADLOCK",
      errno: 1213,
    });
    const first = transactionalConnection();
    first.query
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([[{ id: 7, latest_context_version: 4 }], []])
      .mockRejectedValueOnce(deadlock);
    const second = transactionalConnection();
    second.query
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([[{ id: 7, latest_context_version: 4 }], []])
      .mockResolvedValueOnce([{ insertId: 102 }, []]);
    const getConnection = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection,
    } as never);

    await expect(
      repo.createAnalyzeTurn({
        sessionId: 7,
        idempotencyKey: "analyze-deadlock",
        requestHash: "i".repeat(64),
      }),
    ).resolves.toEqual({
      turnJobId: 102,
      messageId: null,
      status: "queued",
      deduplicated: false,
    });

    expect(getConnection).toHaveBeenCalledTimes(2);
    expect(first.rollback).toHaveBeenCalledOnce();
    expect(first.release).toHaveBeenCalledOnce();
    expect(second.commit).toHaveBeenCalledOnce();
  });

  it("createAnalyzeTurn can reset progress and create the turn in one transaction", async () => {
    const connection = transactionalConnection();
    connection.query.mockImplementation(async (sql: unknown) => {
      const statement = String(sql);
      if (statement.includes("FROM compose_turn_jobs")) return [[], []];
      if (statement.includes("SELECT id, latest_context_version")) {
        return [[{ id: 7, latest_context_version: null }], []];
      }
      if (statement.includes("INSERT INTO compose_turn_jobs")) {
        return [{ insertId: 102, affectedRows: 1 }, []];
      }
      if (statement.includes("INSERT INTO spec_factory_outbox")) {
        return [{ insertId: 302, affectedRows: 1 }, []];
      }
      return [{ affectedRows: 1 }, []];
    });
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(
      repo.createAnalyzeTurn({
        sessionId: 7,
        idempotencyKey: "analyze-reset-abc",
        requestHash: "d".repeat(64),
        resetSessionProgress: true,
      }),
    ).resolves.toEqual({
      turnJobId: 102,
      messageId: null,
      status: "queued",
      deduplicated: false,
    });

    const sql = connection.query.mock.calls.map((call) => String(call[0]));
    expect(
      sql.some((statement) =>
        statement.includes("DELETE FROM compose_turn_outputs"),
      ),
    ).toBe(true);
    expect(
      sql.some((statement) =>
        statement.includes("UPDATE compose_context_patches"),
      ),
    ).toBe(true);
    expect(sql.some((statement) => statement.includes("DELETE chunks"))).toBe(
      true,
    );
    expect(
      sql.some((statement) => statement.includes("DELETE revisions")),
    ).toBe(true);
    expect(
      sql.some((statement) =>
        statement.includes("DELETE FROM compose_agent_runtime_runs"),
      ),
    ).toBe(true);
    expect(
      sql.some((statement) =>
        statement.includes("DELETE FROM compose_turn_jobs"),
      ),
    ).toBe(true);
    expect(
      sql.some((statement) =>
        statement.includes("INSERT INTO spec_factory_outbox"),
      ),
    ).toBe(true);
    expect(
      sql.some((statement) =>
        statement.includes("DELETE FROM compose_session_messages"),
      ),
    ).toBe(true);
    expect(
      sql.some((statement) =>
        statement.includes("DELETE FROM compose_workspace_manifests"),
      ),
    ).toBe(true);
    expect(
      sql.some(
        (statement) =>
          statement.includes("UPDATE compose_sessions") &&
          statement.includes("readiness_json = NULL"),
      ),
    ).toBe(true);
    expect(
      sql.some(
        (statement) =>
          statement.includes("SELECT id, latest_context_version") &&
          statement.includes("FOR UPDATE"),
      ),
    ).toBe(true);
    expect(
      sql.some((statement) =>
        statement.includes("INSERT INTO compose_turn_jobs"),
      ),
    ).toBe(true);
    expect(connection.commit).toHaveBeenCalledOnce();
  });

  it("createAgentTask inserts a queued task with explicit scheduling metadata", async () => {
    const connection = transactionalConnection();
    connection.query
      .mockResolvedValueOnce([{ insertId: 501, affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ insertId: 901, affectedRows: 1 }, []]);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(
      repo.createAgentTask({
        sessionId: 7,
        turnJobId: 101,
        capability: "source_distillation",
        executorType: "source_distillation",
        input: { sourceId: 12 },
        priority: 50,
        maxAttempts: 2,
        outputSourceId: 12,
      }),
    ).resolves.toBe(501);

    const sql = String(connection.query.mock.calls[0][0]);
    expect(sql).toContain("INSERT INTO compose_agent_tasks");
    expect(sql).toContain("FROM compose_sessions");
    expect(sql).toContain("status <> 'archived'");
    expect(sql).toContain("input_json");
    expect(connection.query.mock.calls[0][1]).toEqual([
      7,
      101,
      "source_distillation",
      "source_distillation",
      null,
      50,
      JSON.stringify({ sourceId: 12 }),
      2,
      12,
      7,
    ]);
    expect(String(connection.query.mock.calls[1][0])).toContain(
      "INSERT INTO spec_factory_outbox",
    );
    expect(connection.commit).toHaveBeenCalledOnce();
  });

  it("createAgentTask defaults optional task metadata", async () => {
    const connection = transactionalConnection();
    connection.query
      .mockResolvedValueOnce([{ insertId: 502, affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ insertId: 902, affectedRows: 1 }, []]);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(
      repo.createAgentTask({
        sessionId: 7,
        capability: "context_merge",
        input: null,
      }),
    ).resolves.toBe(502);

    expect(connection.query.mock.calls[0][1]).toEqual([
      7,
      null,
      "context_merge",
      null,
      null,
      100,
      JSON.stringify(null),
      3,
      null,
      7,
    ]);
  });

  it("createAgentTask rejects when the session is missing or archived", async () => {
    const connection = transactionalConnection();
    connection.query.mockResolvedValueOnce([
      { insertId: 0, affectedRows: 0 },
      [],
    ]);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(
      repo.createAgentTask({
        sessionId: 7,
        capability: "code_research",
        input: { question: "Where is retry logic?" },
      }),
    ).rejects.toThrow("Compose session 7 was not found");
    expect(connection.rollback).toHaveBeenCalledOnce();
  });

  it("createHandoffBuildTask keeps legacy source ids out of output_source_id", async () => {
    const connection = transactionalConnection();
    connection.query
      .mockResolvedValueOnce([[{ id: 7, latest_context_version: 4 }], []])
      .mockResolvedValueOnce([[{ message_high_watermark_id: 900 }], []])
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([{ insertId: 701, affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ insertId: 501, affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ insertId: 901, affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ insertId: 902, affectedRows: 1 }, []]);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(
      repo.createHandoffBuildTask({
        sessionId: 7,
        sourceId: 88,
        idempotencyKey: "repair-4-session-7",
        requestedBy: "context-v4-repair",
        reusedExistingSource: true,
      }),
    ).resolves.toMatchObject({
      handoffId: 701,
      agentTaskId: 501,
      requestedContextVersion: 4,
      messageHighWatermarkId: 900,
      deduplicated: false,
    });

    const taskSql = String(connection.query.mock.calls[4][0]);
    const taskParams = connection.query.mock.calls[4][1] as unknown[];
    expect(taskSql).toContain("INSERT INTO compose_agent_tasks");
    expect(taskSql).not.toContain("output_source_id");
    expect(taskParams).toHaveLength(3);
    expect(taskParams.slice(0, 2)).toEqual([7, null]);
    expect(JSON.parse(String(taskParams[2]))).toMatchObject({
      handoffId: 701,
      sourceId: 88,
      actor: "context-v4-repair",
      contextVersionUsed: 4,
      messageHighWatermarkId: 900,
      reusedExistingSource: true,
    });
    expect(connection.commit).toHaveBeenCalledOnce();
  });

  it("getSessionResearchBudgetUsage sums committed spend and queued research reservations", async () => {
    const query = vi.fn().mockResolvedValueOnce([
      [
        {
          spent_cost_usd: "0.750000",
          reserved_cost_usd: "1.250000",
          research_tasks_24h: 2,
          in_flight_tasks: 1,
        },
      ],
      [],
    ]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);
    const since = new Date("2026-07-05T10:00:00.000Z");

    await expect(
      repo.getSessionResearchBudgetUsage({ sessionId: 7, since }),
    ).resolves.toEqual({
      spentCostUsd: 0.75,
      reservedCostUsd: 1.25,
      researchTasks24h: 2,
      inFlightTasks: 1,
    });

    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("FROM spec_factory_llm_calls");
    expect(sql).toContain("FROM compose_agent_runtime_runs runtime_run");
    expect(sql).toContain("JOIN compose_agent_tasks runtime_task");
    expect(sql).toContain("SUM(spent.estimated_cost_usd)");
    expect(sql).toContain("FROM compose_agent_tasks");
    expect(sql).toContain("JSON_EXTRACT(input_json, '$.maxCostUsd')");
    expect(sql).toContain("capability IN (?, ?, ?)");
    expect(sql).toContain("status IN ('queued', 'running')");
    expect(query.mock.calls[0][1]).toEqual([
      7,
      since,
      7,
      since,
      "code_research",
      "config_research",
      "devops_research",
      7,
      since,
      "code_research",
      "config_research",
      "devops_research",
      7,
      since,
      "code_research",
      "config_research",
      "devops_research",
      7,
      "code_research",
      "config_research",
      "devops_research",
    ]);
  });

  it("getGlobalResearchBudgetUsage sums global spend and research reservations", async () => {
    const query = vi.fn().mockResolvedValueOnce([
      [
        {
          spent_cost_usd: "2.750000",
          reserved_cost_usd: "1.500000",
          research_tasks_24h: 4,
          in_flight_tasks: 2,
        },
      ],
      [],
    ]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);
    const since = new Date("2026-07-05T10:00:00.000Z");

    await expect(repo.getGlobalResearchBudgetUsage({ since })).resolves.toEqual(
      {
        spentCostUsd: 2.75,
        reservedCostUsd: 1.5,
        researchTasks24h: 4,
        inFlightTasks: 2,
      },
    );

    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("FROM spec_factory_llm_calls");
    expect(sql).toContain("FROM compose_agent_runtime_runs runtime_run");
    expect(sql).toContain("JOIN compose_agent_tasks runtime_task");
    expect(sql).toContain("FROM compose_agent_tasks");
    expect(sql).not.toContain("session_id = ?");
    expect(sql).toContain("capability IN (?, ?, ?)");
    expect(query.mock.calls[0][1]).toEqual([
      since,
      since,
      "code_research",
      "config_research",
      "devops_research",
      since,
      "code_research",
      "config_research",
      "devops_research",
      since,
      "code_research",
      "config_research",
      "devops_research",
      "code_research",
      "config_research",
      "devops_research",
    ]);
  });

  it("listTurnAgentTasks returns research history for coordinator fan-in", async () => {
    const query = vi.fn().mockResolvedValueOnce([
      [
        {
          id: 501,
          session_id: 7,
          turn_job_id: 101,
          capability: "code_research",
          executor_type: "code_research",
          status: "failed",
          input_json: JSON.stringify({
            question: "Where is retry implemented?",
            maxCostUsd: 1.25,
          }),
          output_source_id: null,
          error_code: "research_failed",
          error_message: "tool timeout",
          attempt_count: 2,
          max_attempts: 2,
          created_at: new Date("2026-07-05T10:00:00.000Z"),
          completed_at: new Date("2026-07-05T10:05:00.000Z"),
        },
      ],
      [],
    ]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);

    await expect(repo.listTurnAgentTasks(101)).resolves.toEqual([
      {
        id: 501,
        sessionId: 7,
        turnJobId: 101,
        capability: "code_research",
        executorType: "code_research",
        status: "failed",
        input: {
          question: "Where is retry implemented?",
          maxCostUsd: 1.25,
        },
        question: "Where is retry implemented?",
        maxCostUsd: 1.25,
        outputSourceId: null,
        errorCode: "research_failed",
        errorMessage: "tool timeout",
        attemptCount: 2,
        maxAttempts: 2,
        createdAt: "2026-07-05T10:00:00.000Z",
        completedAt: "2026-07-05T10:05:00.000Z",
      },
    ]);

    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("FROM compose_agent_tasks");
    expect(sql).toContain("WHERE turn_job_id = ?");
    expect(sql).toContain("ORDER BY created_at ASC, id ASC");
    expect(query.mock.calls[0][1]).toEqual([101]);
  });

  it("parkTurnForResearch inserts linked tasks and parks the fenced turn", async () => {
    const connection = transactionalConnection();
    connection.query
      .mockResolvedValueOnce([
        [
          {
            id: 101,
            session_id: 7,
            status: "running",
            active_worker_id: "legacy-compose-service",
            lease_generation: 1,
            lease_active: 1,
          },
        ],
        [],
      ])
      .mockResolvedValueOnce([
        [{ id: 7, status: "draft", archived_at: null }],
        [],
      ])
      .mockResolvedValueOnce([{ insertId: 501, affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(
      repo.parkTurnForResearch({
        sessionId: 7,
        turnJobId: 101,
        lease: {
          workerId: "legacy-compose-service",
          leaseGeneration: 1,
        },
        tasks: [
          {
            capability: "code_research",
            executorType: "code_research",
            priority: 70,
            maxAttempts: 2,
            outputSourceId: null,
            input: {
              question: "Where is retry implemented?",
              contextVersionUsed: 4,
            },
          },
        ],
      }),
    ).resolves.toEqual({ parked: true, agentTaskIds: [501] });

    expect(String(connection.query.mock.calls[0][0])).toContain(
      "FROM compose_turn_jobs",
    );
    expect(String(connection.query.mock.calls[0][0])).toContain("FOR UPDATE");
    expect(String(connection.query.mock.calls[1][0])).toContain(
      "FROM compose_sessions",
    );
    expect(String(connection.query.mock.calls[1][0])).toContain("FOR UPDATE");
    expect(String(connection.query.mock.calls[2][0])).toContain(
      "INSERT INTO compose_agent_tasks",
    );
    expect(connection.query.mock.calls[2][1]).toEqual([
      7,
      101,
      "code_research",
      "code_research",
      null,
      70,
      JSON.stringify({
        question: "Where is retry implemented?",
        contextVersionUsed: 4,
      }),
      2,
      null,
      7,
    ]);
    const parkSql = String(connection.query.mock.calls[3][0]);
    expect(parkSql).toContain("status = 'waiting_on_research'");
    expect(parkSql).toContain("active_worker_id = NULL");
    expect(parkSql).toContain("lease_until = NULL");
    expect(connection.query.mock.calls[3][1]).toEqual([101]);
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.rollback).not.toHaveBeenCalled();
  });

  it("parkTurnForResearch rejects an expired active lease before enqueueing tasks", async () => {
    const connection = transactionalConnection();
    connection.query
      .mockResolvedValueOnce([
        [
          {
            id: 101,
            session_id: 7,
            status: "running",
            active_worker_id: "legacy-compose-service",
            lease_generation: 1,
            lease_active: 0,
          },
        ],
        [],
      ])
      .mockResolvedValueOnce([
        [{ id: 7, status: "draft", archived_at: null }],
        [],
      ])
      .mockResolvedValueOnce([{ insertId: 501, affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(
      repo.parkTurnForResearch({
        sessionId: 7,
        turnJobId: 101,
        lease: {
          workerId: "legacy-compose-service",
          leaseGeneration: 1,
        },
        tasks: [
          {
            capability: "code_research",
            executorType: "code_research",
            priority: 70,
            maxAttempts: 2,
            outputSourceId: null,
            input: { question: "Where is retry implemented?" },
          },
        ],
      }),
    ).resolves.toBeNull();

    const selectSql = String(connection.query.mock.calls[0][0]);
    expect(selectSql).toContain("lease_until >= CURRENT_TIMESTAMP(3)");
    expect(connection.query).toHaveBeenCalledOnce();
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.rollback).not.toHaveBeenCalled();
  });

  it("parkTurnForClarification writes the question and clears the active lease", async () => {
    const connection = transactionalConnection();
    const expiresAt = new Date("2026-07-07T11:00:00.000Z");
    connection.query
      .mockResolvedValueOnce([
        [
          {
            id: 101,
            session_id: 7,
            status: "running",
            active_worker_id: "legacy-compose-service",
            lease_generation: 1,
            lease_active: 1,
          },
        ],
        [],
      ])
      .mockResolvedValueOnce([
        [{ id: 7, status: "draft", archived_at: null }],
        [],
      ])
      .mockResolvedValueOnce([{ insertId: 52, affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(
      repo.parkTurnForClarification({
        sessionId: 7,
        turnJobId: 101,
        lease: {
          workerId: "legacy-compose-service",
          leaseGeneration: 1,
        },
        question: "Which repository should I inspect?",
        reason: "The session has no selected repository.",
        expiresAt,
        contextVersionUsed: 4,
      }),
    ).resolves.toEqual({ parked: true, assistantMessageId: 52 });

    expect(String(connection.query.mock.calls[0][0])).toContain(
      "FROM compose_turn_jobs",
    );
    expect(String(connection.query.mock.calls[0][0])).toContain("FOR UPDATE");
    expect(String(connection.query.mock.calls[1][0])).toContain(
      "FROM compose_sessions",
    );
    expect(String(connection.query.mock.calls[2][0])).toContain(
      "INSERT INTO compose_session_messages",
    );
    expect(String(connection.query.mock.calls[2][0])).toContain("turn_job_id");
    expect(connection.query.mock.calls[2][1]).toEqual([
      7,
      "assistant",
      "Which repository should I inspect?",
      101,
      4,
      "clarification_question",
    ]);
    const parkSql = String(connection.query.mock.calls[3][0]);
    expect(parkSql).toContain("status = 'awaiting_user_input'");
    expect(parkSql).toContain("clarification_expires_at = ?");
    expect(parkSql).toContain("active_worker_id = NULL");
    expect(parkSql).toContain("lease_until = NULL");
    expect(connection.query.mock.calls[3][1]).toEqual([4, expiresAt, 101]);
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.rollback).not.toHaveBeenCalled();
  });

  it("parkTurnForClarification rejects an expired active lease before writing a question", async () => {
    const connection = transactionalConnection();
    const expiresAt = new Date("2026-07-07T11:00:00.000Z");
    connection.query
      .mockResolvedValueOnce([
        [
          {
            id: 101,
            session_id: 7,
            status: "running",
            active_worker_id: "legacy-compose-service",
            lease_generation: 1,
            lease_active: 0,
          },
        ],
        [],
      ])
      .mockResolvedValueOnce([
        [{ id: 7, status: "draft", archived_at: null }],
        [],
      ])
      .mockResolvedValueOnce([{ insertId: 52, affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(
      repo.parkTurnForClarification({
        sessionId: 7,
        turnJobId: 101,
        lease: {
          workerId: "legacy-compose-service",
          leaseGeneration: 1,
        },
        question: "Which repository should I inspect?",
        reason: "The session has no selected repository.",
        expiresAt,
        contextVersionUsed: 4,
      }),
    ).resolves.toBeNull();

    const selectSql = String(connection.query.mock.calls[0][0]);
    expect(selectSql).toContain("lease_until >= CURRENT_TIMESTAMP(3)");
    expect(connection.query).toHaveBeenCalledOnce();
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.rollback).not.toHaveBeenCalled();
  });

  it("answerAwaitingClarification appends another answer round and requeues the same turn", async () => {
    const connection = transactionalConnection();
    connection.query
      .mockResolvedValueOnce([[{ id: 7 }], []])
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([
        [
          {
            id: 101,
            session_id: 7,
            user_message_id: 51,
            status: "awaiting_user_input",
            clarification_expires_at: "2099-07-07T11:00:00.000Z",
            clarification_answer_message_id: 60,
            clarification_answer_idempotency_key: "clar-answer-prior",
            context_version_used: 4,
          },
        ],
        [],
      ])
      .mockResolvedValueOnce([{ insertId: 61, affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ insertId: 701, affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ insertId: 801, affectedRows: 1 }, []]);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(
      repo.answerAwaitingClarification({
        sessionId: 7,
        content: "billing-service",
        idempotencyKey: "clar-answer-1",
      }),
    ).resolves.toEqual({
      answered: true,
      turnJobId: 101,
      messageId: 61,
      status: "queued",
      userMessageId: 51,
      deduplicated: false,
    });

    expect(String(connection.query.mock.calls[0][0])).toContain(
      "FROM compose_sessions",
    );
    expect(connection.query.mock.calls[0][1]).toEqual([7]);
    expect(String(connection.query.mock.calls[1][0])).toContain(
      "m.clarification_idempotency_key = ?",
    );
    expect(connection.query.mock.calls[1][1]).toEqual([7, "clar-answer-1"]);

    const selectSql = String(connection.query.mock.calls[2][0]);
    expect(selectSql).toContain("FROM compose_turn_jobs j");
    expect(selectSql).toContain("j.status = 'awaiting_user_input'");
    expect(selectSql).toContain("FOR UPDATE");
    expect(connection.query.mock.calls[2][1]).toEqual([7]);

    expect(String(connection.query.mock.calls[3][0])).toContain(
      "INSERT INTO compose_session_messages",
    );
    expect(String(connection.query.mock.calls[3][0])).toContain(
      "clarification_idempotency_key",
    );
    expect(connection.query.mock.calls[3][1]).toEqual([
      7,
      "user",
      "billing-service",
      101,
      "clarification_answer",
      "clar-answer-1",
    ]);

    const updateSql = String(connection.query.mock.calls[4][0]);
    expect(updateSql).toContain("status = 'queued'");
    expect(updateSql).toContain("attempt_count = 0");
    expect(updateSql).toContain("clarification_answer_message_id = ?");
    expect(updateSql).toContain("clarification_answer_idempotency_key = ?");
    expect(connection.query.mock.calls[4][1]).toEqual([
      61,
      "clar-answer-1",
      101,
    ]);
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.rollback).not.toHaveBeenCalled();
  });

  it("answerAwaitingClarification returns the prior answer for a repeated key", async () => {
    const connection = transactionalConnection();
    connection.query
      .mockResolvedValueOnce([[{ id: 7 }], []])
      .mockResolvedValueOnce([
        [
          {
            id: 61,
            turn_job_id: 101,
            content: "billing-service",
            turn_status: "queued",
            user_message_id: 51,
          },
        ],
        [],
      ]);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(
      repo.answerAwaitingClarification({
        sessionId: 7,
        content: "billing-service",
        idempotencyKey: "clar-answer-1",
      }),
    ).resolves.toEqual({
      answered: true,
      turnJobId: 101,
      messageId: 61,
      status: "queued",
      userMessageId: 51,
      deduplicated: true,
    });

    expect(connection.query).toHaveBeenCalledTimes(2);
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.rollback).not.toHaveBeenCalled();
  });

  it("answerAwaitingClarification rejects a prior answer key with different content", async () => {
    const connection = transactionalConnection();
    connection.query
      .mockResolvedValueOnce([[{ id: 7 }], []])
      .mockResolvedValueOnce([
        [
          {
            id: 61,
            turn_job_id: 101,
            content: "billing-service",
            turn_status: "queued",
            user_message_id: 51,
          },
        ],
        [],
      ]);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(
      repo.answerAwaitingClarification({
        sessionId: 7,
        content: "payments-service",
        idempotencyKey: "clar-answer-1",
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);

    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.rollback).toHaveBeenCalledOnce();
  });

  it("expireStaleClarificationTurns abandons expired parked turns", async () => {
    const connection = transactionalConnection();
    const expiredBefore = new Date("2026-07-07T12:00:00.000Z");
    connection.query
      .mockResolvedValueOnce([
        [
          { id: 101, session_id: 7 },
          { id: 102, session_id: 8 },
        ],
        [],
      ])
      .mockResolvedValueOnce([{ affectedRows: 2 }, []]);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(
      repo.expireStaleClarificationTurns({
        expiredBefore,
        limit: 10,
      }),
    ).resolves.toEqual([
      { turnJobId: 101, sessionId: 7 },
      { turnJobId: 102, sessionId: 8 },
    ]);

    const selectSql = String(connection.query.mock.calls[0][0]);
    expect(selectSql).toContain("FROM compose_turn_jobs j");
    expect(selectSql).toContain("JOIN compose_sessions s");
    expect(selectSql).toContain("s.status <> 'archived'");
    expect(selectSql).toContain("j.status = 'awaiting_user_input'");
    expect(selectSql).toContain("j.clarification_expires_at < ?");
    expect(selectSql).toContain("FOR UPDATE");
    expect(connection.query.mock.calls[0][1]).toEqual([expiredBefore, 10]);

    const updateSql = String(connection.query.mock.calls[1][0]);
    expect(updateSql).toContain("status = 'abandoned'");
    expect(updateSql).toContain("error_code = 'clarification_expired'");
    expect(updateSql).toContain("id IN (?, ?)");
    expect(connection.query.mock.calls[1][1]).toEqual([101, 102]);
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.rollback).not.toHaveBeenCalled();
  });

  it("claimNextAgentTask claims one queued task with a new lease generation", async () => {
    const connection = transactionalConnection();
    const leaseUntil = new Date("2026-07-05T10:05:00.000Z");
    connection.query
      .mockResolvedValueOnce([
        [
          {
            id: 501,
            session_id: 7,
            turn_job_id: 101,
            capability: "source_distillation",
            executor_type: "source_distillation",
            request_id: "request-agent-501",
            status: "queued",
            input_json: JSON.stringify({ sourceId: 12 }),
            lease_generation: 0,
            active_worker_id: null,
            updated_at: "2026-07-05T10:00:00.000Z",
          },
        ],
        [],
      ])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])
      .mockResolvedValueOnce([
        [
          {
            id: 501,
            session_id: 7,
            turn_job_id: 101,
            capability: "source_distillation",
            executor_type: "source_distillation",
            request_id: "request-agent-501",
            status: "running",
            input_json: JSON.stringify({ sourceId: 12 }),
            lease_generation: 1,
            active_worker_id: "agent-worker-a",
          },
        ],
        [],
      ]);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(
      repo.claimNextAgentTask({
        workerId: "agent-worker-a",
        leaseUntil,
        capabilities: ["source_distillation", "context_merge"],
      }),
    ).resolves.toEqual({
      id: 501,
      sessionId: 7,
      turnJobId: 101,
      capability: "source_distillation",
      executorType: "source_distillation",
      requestId: "request-agent-501",
      status: "running",
      input: { sourceId: 12 },
      leaseGeneration: 1,
      activeWorkerId: "agent-worker-a",
      queuedAt: "2026-07-05T10:00:00.000Z",
    });

    const selectSql = String(connection.query.mock.calls[0][0]);
    expect(selectSql).toContain("FROM compose_agent_tasks");
    expect(selectSql).toContain("t.updated_at");
    expect(selectSql).toContain("EXISTS (");
    expect(selectSql).toContain("status <> 'archived'");
    expect(selectSql).toContain("capability IN (?, ?)");
    expect(selectSql).toContain(
      "ORDER BY t.priority ASC, t.created_at ASC, t.id ASC",
    );
    expect(selectSql).toContain("FOR UPDATE SKIP LOCKED");
    expect(connection.query.mock.calls[0][1]).toEqual([
      "source_distillation",
      "context_merge",
    ]);
    expect(String(connection.query.mock.calls[1][0])).toContain(
      "lease_generation = lease_generation + 1",
    );
    expect(String(connection.query.mock.calls[1][0])).toContain(
      "attempt_count = attempt_count + 1",
    );
    expect(connection.query.mock.calls[1][1]).toEqual([
      "agent-worker-a",
      leaseUntil,
      501,
    ]);
    expect(connection.commit).toHaveBeenCalledOnce();
  });

  it("completeAgentTask fences completion by worker and lease generation", async () => {
    const connection = transactionalConnection();
    connection.query
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ affectedRows: 0 }, []]);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(
      repo.completeAgentTask({
        agentTaskId: 501,
        workerId: "agent-worker-a",
        leaseGeneration: 2,
        output: { summary: "distilled" },
        contextVersionUsed: 4,
        outputSourceId: 12,
      }),
    ).resolves.toBe(true);

    const sql = String(connection.query.mock.calls[0][0]);
    expect(sql).toContain("UPDATE compose_agent_tasks");
    expect(sql).toContain("status = 'completed'");
    expect(sql).toContain("output_json = CAST(? AS JSON)");
    expect(sql).toContain("active_worker_id = NULL");
    expect(sql).toContain("lease_generation = ?");
    expect(sql).toContain("lease_until >= CURRENT_TIMESTAMP(3)");
    expect(sql).toContain("status <> 'archived'");
    expect(connection.query.mock.calls[0][1]).toEqual([
      JSON.stringify({ summary: "distilled" }),
      4,
      12,
      501,
      "agent-worker-a",
      2,
    ]);
    expect(connection.commit).toHaveBeenCalledOnce();
  });

  it("completeAgentTask wakes a parked turn after all linked tasks are terminal", async () => {
    const connection = transactionalConnection();
    connection.query
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(
      repo.completeAgentTask({
        agentTaskId: 501,
        workerId: "agent-worker-a",
        leaseGeneration: 2,
        output: { sourceId: 42 },
        contextVersionUsed: 4,
        outputSourceId: 42,
      }),
    ).resolves.toBe(true);

    const completeSql = String(connection.query.mock.calls[0][0]);
    expect(completeSql).toContain("UPDATE compose_agent_tasks");
    expect(completeSql).toContain("status = 'completed'");

    const wakeSql = String(connection.query.mock.calls[1][0]);
    expect(wakeSql).toContain("UPDATE compose_turn_jobs");
    expect(wakeSql).toContain("j.status = 'queued'");
    expect(wakeSql).toContain("j.attempt_count = 0");
    expect(wakeSql).not.toContain("turn_attempts_exhausted");
    expect(wakeSql).toContain("status = 'waiting_on_research'");
    expect(wakeSql).toContain("NOT EXISTS");
    expect(wakeSql).toContain("status IN ('queued', 'running')");
    expect(connection.query.mock.calls[1][1]).toEqual([501, 501]);
    expect(connection.commit).toHaveBeenCalledOnce();
  });

  it("startAgentRuntimeRun inserts a running executor attempt row", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([{ insertId: 7001, affectedRows: 1 }, []]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);

    await expect(
      repo.startAgentRuntimeRun({
        sessionId: 7,
        agentTaskId: 501,
        executorType: "source_distillation",
        workspaceUri: "file:///scratch/session-7",
      }),
    ).resolves.toBe(7001);

    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("INSERT INTO compose_agent_runtime_runs");
    expect(sql).toContain("status, started_at");
    expect(query.mock.calls[0][1]).toEqual([
      7,
      501,
      "source_distillation",
      "file:///scratch/session-7",
    ]);
  });

  it("finishAgentRuntimeRun records terminal runtime metadata", async () => {
    const query = vi.fn().mockResolvedValueOnce([{ affectedRows: 1 }, []]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);

    await expect(
      repo.finishAgentRuntimeRun({
        runtimeRunId: 7001,
        status: "completed",
        provider: "bedrock",
        model: "anthropic.claude-3-5-sonnet",
        traceUri: "s3://bucket/trace.jsonl",
        outputArtifactUri: "s3://bucket/output.md",
        inputTokens: 1200,
        outputTokens: 300,
        estimatedCostUsd: 0.42,
        errorCode: null,
        errorMessage: null,
      }),
    ).resolves.toBe(true);

    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("UPDATE compose_agent_runtime_runs");
    expect(sql).toContain("status = ?");
    expect(sql).toContain("completed_at = CURRENT_TIMESTAMP(3)");
    expect(sql).toContain("WHERE id = ?");
    expect(sql).toContain("AND status = 'running'");
    expect(query.mock.calls[0][1]).toEqual([
      "completed",
      "bedrock",
      "anthropic.claude-3-5-sonnet",
      "s3://bucket/trace.jsonl",
      "s3://bucket/output.md",
      1200,
      300,
      0.42,
      null,
      null,
      7001,
    ]);
  });

  it("confirmAgentTaskLease checks the active worker lease before side effects", async () => {
    const query = vi.fn().mockResolvedValueOnce([[{ id: 501 }], []]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);

    await expect(
      repo.confirmAgentTaskLease({
        agentTaskId: 501,
        workerId: "agent-worker-a",
        leaseGeneration: 2,
      }),
    ).resolves.toBe(true);

    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("FROM compose_agent_tasks");
    expect(sql).toContain("JOIN compose_sessions");
    expect(sql).toContain("active_worker_id = ?");
    expect(sql).toContain("lease_generation = ?");
    expect(sql).toContain("status = 'running'");
    expect(sql).toContain("lease_until >= CURRENT_TIMESTAMP(3)");
    expect(sql).toContain("status <> 'archived'");
    expect(query.mock.calls[0][1]).toEqual([501, "agent-worker-a", 2]);
  });

  it("markAgentTaskFailed requeues retryable failures and fences by lease", async () => {
    const connection = transactionalConnection();
    connection.query
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ affectedRows: 0 }, []]);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(
      repo.markAgentTaskFailed({
        agentTaskId: 501,
        workerId: "agent-worker-a",
        leaseGeneration: 2,
        errorCode: "executor_failed",
        errorMessage: "distillation failed",
      }),
    ).resolves.toBe(true);

    const sql = String(connection.query.mock.calls[0][0]);
    expect(sql).toContain("UPDATE compose_agent_tasks");
    expect(sql).toContain(
      "status = CASE WHEN attempt_count < max_attempts THEN 'queued' ELSE 'failed' END",
    );
    expect(sql).toContain("error_code = ?");
    expect(sql).toContain("error_message = ?");
    expect(sql).toContain("active_worker_id = NULL");
    expect(sql).toContain("lease_generation = ?");
    expect(sql).toContain("lease_until >= CURRENT_TIMESTAMP(3)");
    expect(sql).toContain("status <> 'archived'");
    expect(sql).toContain(
      "started_at = CASE WHEN attempt_count < max_attempts THEN NULL ELSE started_at END",
    );
    expect(sql).toContain(
      "completed_at = CASE WHEN attempt_count < max_attempts THEN NULL ELSE CURRENT_TIMESTAMP(3) END",
    );
    expect(connection.query.mock.calls[0][1]).toEqual([
      "executor_failed",
      "distillation failed",
      501,
      "agent-worker-a",
      2,
    ]);
    expect(connection.commit).toHaveBeenCalledOnce();
  });

  it("markAgentTaskFailed wakes a parked turn after linked tasks are terminal", async () => {
    const connection = transactionalConnection();
    connection.query
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(
      repo.markAgentTaskFailed({
        agentTaskId: 501,
        workerId: "agent-worker-a",
        leaseGeneration: 2,
        errorCode: "executor_failed",
        errorMessage: "research failed",
      }),
    ).resolves.toBe(true);

    const failSql = String(connection.query.mock.calls[0][0]);
    expect(failSql).toContain("UPDATE compose_agent_tasks");
    expect(failSql).toContain(
      "status = CASE WHEN attempt_count < max_attempts THEN 'queued' ELSE 'failed' END",
    );

    const wakeSql = String(connection.query.mock.calls[1][0]);
    expect(wakeSql).toContain("UPDATE compose_turn_jobs");
    expect(wakeSql).toContain("j.status = 'queued'");
    expect(wakeSql).toContain("j.attempt_count = 0");
    expect(wakeSql).toContain("j.error_code = NULL");
    expect(wakeSql).toContain("status = 'waiting_on_research'");
    expect(wakeSql).toContain("NOT EXISTS");
    expect(wakeSql).toContain("status IN ('queued', 'running')");
    expect(connection.query.mock.calls[1][1]).toEqual([501, 501]);
    expect(connection.commit).toHaveBeenCalledOnce();
  });

  it("recoverExpiredAgentTaskLeases requeues retryable tasks and abandons exhausted tasks", async () => {
    const connection = transactionalConnection();
    const expiredBefore = new Date("2026-07-05T10:15:00.000Z");
    connection.query
      .mockResolvedValueOnce([
        [
          {
            id: 501,
            session_id: 7,
            status: "running",
            attempt_count: 1,
            max_attempts: 3,
          },
          {
            id: 502,
            session_id: 8,
            status: "running",
            attempt_count: 3,
            max_attempts: 3,
          },
        ],
        [],
      ])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(
      repo.recoverExpiredAgentTaskLeases({
        expiredBefore,
        limit: 25,
        abandonedErrorMessage: "Agent task lease expired before completion",
      }),
    ).resolves.toEqual({
      requeued: 1,
      abandoned: 1,
    });

    const selectSql = String(connection.query.mock.calls[0][0]);
    expect(selectSql).toContain("FROM compose_agent_tasks");
    expect(selectSql).toContain("JOIN compose_sessions");
    expect(selectSql).toContain("s.status <> 'archived'");
    expect(selectSql).toContain("FOR UPDATE");
    expect(connection.query.mock.calls[0][1]).toEqual([expiredBefore, 25]);

    const requeueSql = String(connection.query.mock.calls[1][0]);
    expect(requeueSql).toContain("status = 'queued'");
    expect(requeueSql).toContain("active_worker_id = NULL");
    expect(requeueSql).toContain("lease_until = NULL");
    expect(requeueSql).toContain("started_at = NULL");
    expect(connection.query.mock.calls[1][1]).toEqual([501]);

    const abandonSql = String(connection.query.mock.calls[2][0]);
    expect(abandonSql).toContain("status = 'abandoned'");
    expect(abandonSql).toContain("error_code = 'lease_expired'");
    expect(connection.query.mock.calls[2][1]).toEqual([
      "Agent task lease expired before completion",
      502,
    ]);

    const wakeSql = String(connection.query.mock.calls[3][0]);
    expect(wakeSql).toContain("UPDATE compose_turn_jobs");
    expect(wakeSql).toContain("j.status = 'queued'");
    expect(wakeSql).toContain("j.attempt_count = 0");
    expect(wakeSql).toContain("status = 'waiting_on_research'");
    expect(connection.query.mock.calls[3][1]).toEqual([502, 502]);
    expect(connection.commit).toHaveBeenCalledOnce();
  });

  it("completeTurnWithAssistantMessage writes the final output once", async () => {
    const connection = transactionalConnection();
    connection.query
      .mockResolvedValueOnce([
        [{ id: 101, session_id: 7, status: "running" }],
        [],
      ])
      .mockResolvedValueOnce([
        [{ id: 7, status: "draft", archived_at: null }],
        [],
      ])
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([{ insertId: 52 }, []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(
      repo.completeTurnWithAssistantMessage({
        turnJobId: 101,
        sessionId: 7,
        content: "Ready",
        contextVersionUsed: null,
        finalPayload: { reply: "Ready" },
      }),
    ).resolves.toEqual({ assistantMessageId: 52, deduplicated: false });

    expect(String(connection.query.mock.calls[0][0])).toContain(
      "FROM compose_turn_jobs",
    );
    expect(String(connection.query.mock.calls[1][0])).toContain(
      "FROM compose_sessions",
    );
    expect(String(connection.query.mock.calls[2][0])).toContain(
      "FROM compose_turn_outputs",
    );
    expect(String(connection.query.mock.calls[3][0])).toContain(
      "INSERT INTO compose_session_messages",
    );
    expect(connection.query.mock.calls[3][1]).toEqual([
      7,
      "assistant",
      "Ready",
      101,
      null,
      "final",
    ]);
    expect(String(connection.query.mock.calls[4][0])).toContain(
      "INSERT INTO compose_turn_outputs",
    );
    expect(connection.query.mock.calls[4][1]).toEqual([
      101,
      7,
      52,
      null,
      JSON.stringify({ reply: "Ready" }),
    ]);
    expect(connection.commit).toHaveBeenCalledOnce();
  });

  it("completeTurnWithAssistantMessage cancels the turn before final output when the session is archived", async () => {
    const connection = transactionalConnection();
    connection.query
      .mockResolvedValueOnce([
        [
          {
            id: 101,
            session_id: 7,
            status: "running",
            active_worker_id: "legacy-compose-service",
            lease_generation: 1,
          },
        ],
        [],
      ])
      .mockResolvedValueOnce([
        [
          {
            id: 7,
            status: "archived",
            archived_at: "2026-07-05T10:00:00.000Z",
          },
        ],
        [],
      ])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(
      repo.completeTurnWithAssistantMessage({
        turnJobId: 101,
        sessionId: 7,
        content: "Ready",
        contextVersionUsed: null,
        finalPayload: { reply: "Ready" },
        lease: {
          workerId: "legacy-compose-service",
          leaseGeneration: 1,
        },
      }),
    ).resolves.toEqual({
      assistantMessageId: null,
      deduplicated: false,
      discardedDueToArchive: true,
    });

    expect(String(connection.query.mock.calls[1][0])).toContain(
      "FROM compose_sessions",
    );
    expect(String(connection.query.mock.calls[1][0])).toContain("FOR UPDATE");
    expect(String(connection.query.mock.calls[2][0])).toContain(
      "status = 'cancelled'",
    );
    expect(String(connection.query.mock.calls[2][0])).toContain(
      "error_code = 'session_archived'",
    );
    expect(connection.query).toHaveBeenCalledTimes(3);
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.rollback).not.toHaveBeenCalled();
  });

  it("appendAssistantMessageIfSessionActive discards the assistant message when the session is archived", async () => {
    const connection = transactionalConnection();
    connection.query.mockResolvedValueOnce([
      [
        {
          id: 7,
          status: "archived",
          archived_at: "2026-07-05T10:00:00.000Z",
        },
      ],
      [],
    ]);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(
      repo.appendAssistantMessageIfSessionActive({
        sessionId: 7,
        content: "Ready",
      }),
    ).resolves.toEqual({
      assistantMessageId: null,
      deduplicated: false,
      discardedDueToArchive: true,
    });

    expect(String(connection.query.mock.calls[0][0])).toContain(
      "FROM compose_sessions",
    );
    expect(String(connection.query.mock.calls[0][0])).toContain("FOR UPDATE");
    expect(connection.query).toHaveBeenCalledTimes(1);
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.rollback).not.toHaveBeenCalled();
  });

  it("appendAssistantMessageIfSessionActive records active assistant provenance", async () => {
    const connection = transactionalConnection();
    connection.query
      .mockResolvedValueOnce([
        [
          {
            id: 7,
            status: "ready",
            archived_at: null,
          },
        ],
        [],
      ])
      .mockResolvedValueOnce([{ insertId: 52, affectedRows: 1 }, []]);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(
      repo.appendAssistantMessageIfSessionActive({
        sessionId: 7,
        content: "Ready",
        contextVersionUsed: 4,
      }),
    ).resolves.toEqual({
      assistantMessageId: 52,
      deduplicated: false,
    });

    const insertSql = String(connection.query.mock.calls[1][0]);
    expect(insertSql).toContain("context_version_used");
    expect(insertSql).toContain("message_kind");
    expect(connection.query.mock.calls[1][1]).toEqual([
      7,
      "assistant",
      "Ready",
      4,
      "final",
    ]);
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.rollback).not.toHaveBeenCalled();
  });

  it("completeTurnWithAssistantMessage rejects a stale lease before output writes", async () => {
    const connection = transactionalConnection();
    connection.query.mockResolvedValueOnce([
      [
        {
          id: 101,
          session_id: 7,
          status: "running",
          active_worker_id: "worker-b",
          lease_generation: 3,
        },
      ],
      [],
    ]);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(
      repo.completeTurnWithAssistantMessage({
        turnJobId: 101,
        sessionId: 7,
        content: "Ready",
        lease: {
          workerId: "worker-a",
          leaseGeneration: 2,
        },
      }),
    ).resolves.toBeNull();

    expect(connection.query).toHaveBeenCalledOnce();
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.rollback).not.toHaveBeenCalled();
  });

  it("claimNextTurnJob claims one queued turn with a new lease generation", async () => {
    const connection = transactionalConnection();
    const leaseUntil = new Date("2026-07-05T10:05:00.000Z");
    connection.query
      .mockResolvedValueOnce([
        [
          {
            id: 101,
            session_id: 7,
            turn_kind: "chat",
            user_message_id: 51,
            status: "queued",
            request_hash: "a".repeat(64),
            request_id: "request-turn-101",
            lease_generation: 0,
            active_worker_id: null,
            requested_context_version: 3,
            context_version_used: null,
            latest_context_version: 4,
            updated_at: "2026-07-05T10:00:00.000Z",
          },
        ],
        [],
      ])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])
      .mockResolvedValueOnce([
        [
          {
            id: 101,
            session_id: 7,
            turn_kind: "chat",
            user_message_id: 51,
            status: "running",
            request_hash: "a".repeat(64),
            request_id: "request-turn-101",
            lease_generation: 1,
            active_worker_id: "worker-a",
            requested_context_version: 3,
            context_version_used: 4,
          },
        ],
        [],
      ]);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(
      repo.claimNextTurnJob({ workerId: "worker-a", leaseUntil }),
    ).resolves.toEqual({
      id: 101,
      sessionId: 7,
      turnKind: "chat",
      userMessageId: 51,
      status: "running",
      requestId: "request-turn-101",
      leaseGeneration: 1,
      activeWorkerId: "worker-a",
      requestedContextVersion: 3,
      contextVersionUsed: 4,
      queuedAt: "2026-07-05T10:00:00.000Z",
    });

    const claimSql = String(connection.query.mock.calls[0][0]);
    expect(claimSql).toContain("j.updated_at");
    expect(claimSql).toContain("JOIN compose_sessions");
    expect(claimSql).toContain("s.status <> 'archived'");
    expect(claimSql).toContain("NOT EXISTS");
    expect(claimSql).toContain("j.attempt_count < j.max_attempts");
    expect(claimSql).toContain("FOR UPDATE SKIP LOCKED");
    expect(String(connection.query.mock.calls[1][0])).toContain(
      "lease_generation = lease_generation + 1",
    );
    expect(String(connection.query.mock.calls[1][0])).toContain(
      "attempt_count = attempt_count + 1",
    );
    expect(connection.query.mock.calls[1][1]).toEqual([
      "worker-a",
      leaseUntil,
      4,
      101,
    ]);
    expect(connection.commit).toHaveBeenCalledOnce();
  });

  it("markTurnJobRunning establishes a lease generation for the legacy executor", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])
      .mockResolvedValueOnce([[{ id: 101, lease_generation: 4 }], []]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);
    const leaseUntil = new Date("2026-07-05T10:05:00.000Z");

    await expect(
      repo.markTurnJobRunning({
        turnJobId: 101,
        workerId: "legacy-compose-service",
        leaseUntil,
      }),
    ).resolves.toEqual({ leaseGeneration: 4 });

    expect(String(query.mock.calls[0][0])).toContain(
      "lease_generation = lease_generation + 1",
    );
    expect(String(query.mock.calls[0][0])).toContain(
      "attempt_count = attempt_count + 1",
    );
    expect(String(query.mock.calls[0][0])).toContain("lease_until = ?");
    expect(String(query.mock.calls[0][0])).toContain("status <> 'archived'");
    expect(query.mock.calls[0][1]).toEqual([
      "legacy-compose-service",
      leaseUntil,
      101,
    ]);
    expect(String(query.mock.calls[1][0])).toContain("lease_generation");
    expect(query.mock.calls[1][1]).toEqual([101]);
  });

  it("renewTurnLease succeeds only for the current worker and lease generation", async () => {
    const query = vi.fn().mockResolvedValueOnce([{ affectedRows: 1 }, []]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);
    const leaseUntil = new Date("2026-07-05T10:10:00.000Z");

    await expect(
      repo.renewTurnLease({
        turnJobId: 101,
        workerId: "worker-a",
        leaseGeneration: 3,
        leaseUntil,
      }),
    ).resolves.toBe(true);

    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("JOIN compose_sessions s ON s.id = j.session_id");
    expect(sql).toContain("s.status <> 'archived'");
    expect(sql).toContain("active_worker_id = ?");
    expect(sql).toContain("lease_generation = ?");
    expect(sql).toContain(
      "status IN ('running', 'waiting_on_research', 'synthesizing')",
    );
    expect(sql).toContain("lease_until >= CURRENT_TIMESTAMP(3)");
    expect(query.mock.calls[0][1]).toEqual([leaseUntil, 101, "worker-a", 3]);
  });

  it("markTurnJobFailed fences failure writes on the active worker lease", async () => {
    const query = vi.fn().mockResolvedValueOnce([{ affectedRows: 0 }, []]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);

    await expect(
      repo.markTurnJobFailed({
        turnJobId: 101,
        errorMessage: "bedrock_throttled",
        lease: {
          workerId: "worker-a",
          leaseGeneration: 3,
        },
      }),
    ).resolves.toBe(false);

    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("JOIN compose_sessions s ON s.id = j.session_id");
    expect(sql).toContain("s.status <> 'archived'");
    expect(sql).toContain("active_worker_id = ?");
    expect(sql).toContain("lease_generation = ?");
    expect(sql).toContain(
      "status IN ('running', 'waiting_on_research', 'synthesizing')",
    );
    expect(sql).toContain(
      "j.lease_until IS NULL OR j.lease_until >= CURRENT_TIMESTAMP(3)",
    );
    expect(query.mock.calls[0][1]).toEqual([
      "bedrock_throttled",
      101,
      "worker-a",
      3,
    ]);
  });

  it("confirmTurnLease rejects stale workers before side effects", async () => {
    const query = vi.fn().mockResolvedValueOnce([[], []]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);

    await expect(
      repo.confirmTurnLease({
        turnJobId: 101,
        workerId: "worker-b",
        leaseGeneration: 2,
      }),
    ).resolves.toBe(false);

    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("JOIN compose_sessions s ON s.id = j.session_id");
    expect(sql).toContain("s.status <> 'archived'");
    expect(sql).toContain("active_worker_id = ?");
    expect(sql).toContain("lease_generation = ?");
    expect(sql).toContain(
      "status IN ('running', 'waiting_on_research', 'synthesizing')",
    );
    expect(sql).toContain("lease_until >= CURRENT_TIMESTAMP(3)");
    expect(query.mock.calls[0][1]).toEqual([101, "worker-b", 2]);
  });

  it("recoverExpiredTurnLeases requeues retryable jobs and abandons exhausted jobs", async () => {
    const connection = transactionalConnection();
    const expiredBefore = new Date("2026-07-05T10:15:00.000Z");
    connection.query
      .mockResolvedValueOnce([
        [
          {
            id: 101,
            session_id: 7,
            status: "running",
            attempt_count: 1,
            max_attempts: 3,
            output_turn_job_id: null,
          },
          {
            id: 102,
            session_id: 8,
            status: "synthesizing",
            attempt_count: 3,
            max_attempts: 3,
            output_turn_job_id: null,
          },
          {
            id: 103,
            session_id: 9,
            status: "running",
            attempt_count: 1,
            max_attempts: 3,
            output_turn_job_id: 103,
          },
        ],
        [],
      ])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ affectedRows: 2 }, []]);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(
      repo.recoverExpiredTurnLeases({
        expiredBefore,
        limit: 25,
        abandonedErrorMessage: "Turn lease expired before completion",
      }),
    ).resolves.toEqual({
      requeued: 1,
      abandoned: 1,
      skippedWithOutput: 1,
    });

    const selectSql = String(connection.query.mock.calls[0][0]);
    expect(selectSql).toContain("JOIN compose_sessions");
    expect(selectSql).toContain("s.status <> 'archived'");
    expect(selectSql).toContain("LEFT JOIN compose_turn_outputs");
    expect(selectSql).toContain("FOR UPDATE");
    expect(selectSql).not.toContain("awaiting_user_input");
    expect(connection.query.mock.calls[0][1]).toEqual([expiredBefore, 25]);

    const requeueSql = String(connection.query.mock.calls[1][0]);
    expect(requeueSql).toContain("status = 'queued'");
    expect(requeueSql).toContain("active_worker_id = NULL");
    expect(requeueSql).toContain("lease_until = NULL");
    expect(requeueSql).toContain("started_at = NULL");
    expect(connection.query.mock.calls[1][1]).toEqual([101]);

    const abandonSql = String(connection.query.mock.calls[2][0]);
    expect(abandonSql).toContain("status = 'abandoned'");
    expect(abandonSql).toContain("error_code = 'lease_expired'");
    expect(connection.query.mock.calls[2][1]).toEqual([
      "Turn lease expired before completion",
      102,
    ]);

    const sessionRepairSql = String(connection.query.mock.calls[3][0]);
    expect(sessionRepairSql).toContain("active_turn_started_at = NULL");
    expect(sessionRepairSql).toContain("NOT EXISTS");
    expect(connection.query.mock.calls[3][1]).toEqual([7, 8]);
    expect(connection.commit).toHaveBeenCalledOnce();
  });

  it("recoverExpiredTurnLeases returns zero counts when no active leases expired", async () => {
    const connection = transactionalConnection();
    connection.query.mockResolvedValueOnce([[], []]);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(
      repo.recoverExpiredTurnLeases({
        expiredBefore: new Date("2026-07-05T10:15:00.000Z"),
        limit: 25,
      }),
    ).resolves.toEqual({
      requeued: 0,
      abandoned: 0,
      skippedWithOutput: 0,
    });

    expect(connection.query).toHaveBeenCalledOnce();
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.rollback).not.toHaveBeenCalled();
  });

  it("listArchivedSessionsForWorkspaceCleanup queries only old archived uncleaned workspaces", async () => {
    const archivedAt = new Date("2026-05-01T00:00:00.000Z");
    const cutoff = new Date("2026-06-01T00:00:00.000Z");
    const query = vi.fn().mockResolvedValueOnce([
      [
        {
          id: 3,
          name: "Billing export",
          s3_prefix: "compose/3/",
          workspace_path: "/mnt/efs/spec-factory/compose/3",
          archived_at: archivedAt,
        },
      ],
      [],
    ]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);

    const rows = await repo.listArchivedSessionsForWorkspaceCleanup({
      archivedBefore: cutoff,
      limit: 25,
    });

    expect(rows).toEqual([
      {
        id: 3,
        name: "Billing export",
        s3Prefix: "compose/3/",
        workspacePath: "/mnt/efs/spec-factory/compose/3",
        archivedAt: "2026-05-01T00:00:00.000Z",
      },
    ]);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("s3_prefix");
    expect(sql).toContain("status = 'archived'");
    expect(sql).toContain("archived_at IS NOT NULL");
    expect(sql).toContain("archived_at < ?");
    expect(sql).toContain("workspace_cleaned_at IS NULL");
    expect(sql).toContain("ORDER BY archived_at ASC, id ASC");
    expect(query.mock.calls[0][1]).toEqual([cutoff, 25]);
  });

  it("marks workspace cleanup success and failure", async () => {
    const query = vi.fn().mockResolvedValue([{ affectedRows: 1 }, []]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);

    await repo.markWorkspaceCleaned(3);
    await repo.markWorkspaceCleanupFailed({
      sessionId: 4,
      errorMessage: "rm failed",
    });

    expect(String(query.mock.calls[0][0])).toContain("workspace_cleaned_at");
    expect(query.mock.calls[0][1]).toEqual([3]);
    expect(String(query.mock.calls[1][0])).toContain("workspace_cleanup_error");
    expect(query.mock.calls[1][1]).toEqual(["rm failed", 4]);
  });

  it("listSessionSourceContents returns filename+content for converted note sources", async () => {
    const query = vi.fn().mockResolvedValueOnce([
      [
        {
          id: 12,
          original_filename: "notes-1.md",
          markdown_content: "Repo is billing-service.",
        },
        {
          id: 13,
          original_filename: "chat.md",
          markdown_content: "We want CSV export.",
        },
      ],
      [],
    ]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);

    const sources = await repo.listSessionSourceContents(3);

    expect(sources).toEqual([
      {
        sourceId: 12,
        filename: "notes-1.md",
        content: "Repo is billing-service.",
      },
      { sourceId: 13, filename: "chat.md", content: "We want CSV export." },
    ]);
  });

  it("linkSource sets source_id and status=handed_off only when unlinked", async () => {
    const query = vi.fn().mockResolvedValueOnce([{ affectedRows: 1 }, []]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);

    await expect(repo.linkSource({ sessionId: 3, sourceId: 88 })).resolves.toBe(
      true,
    );

    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("UPDATE compose_sessions");
    expect(sql).toContain("status = 'handed_off'");
    expect(sql).toContain("source_id IS NULL");
    expect(sql).toContain("status <> 'archived'");
    expect(query.mock.calls[0][1]).toEqual([88, 3]);
  });

  it("linkSource returns false when another handoff already linked the session", async () => {
    const query = vi.fn().mockResolvedValueOnce([{ affectedRows: 0 }, []]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);

    await expect(repo.linkSource({ sessionId: 3, sourceId: 88 })).resolves.toBe(
      false,
    );
  });

  it("getSession returns null when not found", async () => {
    const query = vi.fn().mockResolvedValueOnce([[], []]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);
    expect(await repo.getSession(999)).toBeNull();
  });

  it("addNoteSource stores markdown_content directly (no tagged message)", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([{ insertId: 12, affectedRows: 1 }, []]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);
    const id = await repo.addNoteSource({
      sessionId: 3,
      filename: "note-1.md",
      content: "Repo is billing-service.",
    });
    expect(id).toBe(12);
    expect(query).toHaveBeenCalledTimes(1); // single INSERT, no second message insert
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("INSERT INTO compose_session_sources");
    expect(sql).toContain("FROM compose_sessions");
    expect(sql).toContain("status <> 'archived'");
    expect(sql).toContain("markdown_content");
    expect(query.mock.calls[0][1]).toContain("Repo is billing-service.");
  });

  it("createJiraSource stores fetched Jira markdown as a converted source", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([{ insertId: 31, affectedRows: 1 }, []]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);

    const id = await repo.createJiraSource({
      sessionId: 3,
      jiraKey: "CPDEV-123",
      title: "CPDEV-123 Add export",
      sourceUrl: "https://jira.example.com/browse/CPDEV-123",
      markdownContent: "# CPDEV-123 Add export",
    });

    expect(id).toBe(31);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("INSERT INTO compose_session_sources");
    expect(sql).toContain("FROM compose_sessions");
    expect(sql).toContain("status <> 'archived'");
    expect(sql).toContain("'jira'");
    expect(sql).toContain("'converted'");
    expect(sql).toContain("markdown_content");
    expect(sql).toContain("source_summary");
    expect(sql).toContain("source_entities_json");
    const params = query.mock.calls[0][1] as unknown[];
    expect(params.slice(0, 5)).toEqual([
      3,
      null,
      "CPDEV-123 Add export",
      "https://jira.example.com/browse/CPDEV-123",
      "# CPDEV-123 Add export",
    ]);
    expect(params[5]).toBe("CPDEV-123 Add export");
    expect(JSON.parse(String(params[6]))).toMatchObject({
      jiraKeys: ["CPDEV-123"],
    });
    expect(params[7]).toBe("weak_requirement_detail");
    expect(params[8]).toBe("Too little detail to materially shape the draft.");
  });

  it("createConfluenceSource stores a pending URL source for markitdown", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([{ insertId: 32, affectedRows: 1 }, []]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);

    const id = await runWithSpecFactoryCorrelation(
      { requestId: "request-confluence-32" },
      () =>
        repo.createConfluenceSource({
          sessionId: 3,
          url: "https://wiki.example.com/display/PROJ/Page",
        }),
    );

    expect(id).toBe(32);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("INSERT INTO compose_session_sources");
    expect(sql).toContain("FROM compose_sessions");
    expect(sql).toContain("status <> 'archived'");
    expect(sql).toContain("'confluence'");
    expect(sql).toContain("'markitdown'");
    expect(sql).toContain("'pending'");
    expect(query.mock.calls[0][1]).toEqual([
      3,
      "request-confluence-32",
      "https://wiki.example.com/display/PROJ/Page",
      "https://wiki.example.com/display/PROJ/Page",
      3,
    ]);
  });

  it("createYoutubeSource stores a pending URL source for markitdown", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([{ insertId: 34, affectedRows: 1 }, []]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);

    const id = await repo.createYoutubeSource({
      sessionId: 3,
      url: "https://www.youtube.com/watch?v=abc123",
    });

    expect(id).toBe(34);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("INSERT INTO compose_session_sources");
    expect(sql).toContain("FROM compose_sessions");
    expect(sql).toContain("status <> 'archived'");
    expect(sql).toContain("'youtube'");
    expect(sql).toContain("'markitdown'");
    expect(sql).toContain("'pending'");
    expect(query.mock.calls[0][1]).toEqual([
      3,
      null,
      "https://www.youtube.com/watch?v=abc123",
      "https://www.youtube.com/watch?v=abc123",
      3,
    ]);
  });

  it("restoreConvertedSource imports portable markdown as converted content", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([{ insertId: 33, affectedRows: 1 }, []]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);

    const id = await repo.restoreConvertedSource({
      sessionId: 3,
      kind: "file",
      originalFilename: "requirements.docx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sizeBytes: 2048,
      sourceUrl: null,
      markdownContent: "Build CSV export.",
    });

    expect(id).toBe(33);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("INSERT INTO compose_session_sources");
    expect(sql).toContain("FROM compose_sessions");
    expect(sql).toContain("status <> 'archived'");
    expect(sql).toContain("'none'");
    expect(sql).toContain("'converted'");
    expect(sql).toContain("source_summary");
    expect(sql).toContain("source_entities_json");
    const params = query.mock.calls[0][1] as unknown[];
    expect(params.slice(0, 8)).toEqual([
      3,
      null,
      "file",
      "requirements.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      2048,
      null,
      "Build CSV export.",
    ]);
    expect(params[8]).toBe("Build CSV export.");
    expect(JSON.parse(String(params[9]))).toMatchObject({
      jiraKeys: [],
      repositories: [],
    });
    expect(params[10]).toBe("weak_requirement_detail");
    expect(params[11]).toBe("Too little detail to materially shape the draft.");
  });

  it("createGeneratedResearchSource stores generated research metadata as a converted agent source", async () => {
    const connection = transactionalConnection();
    connection.query
      .mockResolvedValueOnce([[{ id: 7 }], []])
      .mockResolvedValueOnce([[{ id: 12 }, { id: 13 }], []])
      .mockResolvedValueOnce([{ insertId: 61, affectedRows: 1 }, []]);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    const id = await repo.createGeneratedResearchSource({
      sessionId: 7,
      generatedByTaskId: 501,
      originalFilename: "code-research.md",
      markdownContent: "# Research\n\nRepository: billing-service",
      artifactUri: "s3://bucket/compose/7/generated/code-research.md",
      artifactSha256: "a".repeat(64),
      artifactBytes: 2048,
      parentSourceIds: [12, 13],
      contextVersionUsed: 4,
      evidence: { repositories: ["billing-service"] },
      confidence: "high",
    });

    expect(id).toBe(61);
    expect(String(connection.query.mock.calls[0][0])).toContain(
      "FROM compose_sessions",
    );
    expect(String(connection.query.mock.calls[0][0])).toContain(
      "status <> 'archived'",
    );
    const parentSql = String(connection.query.mock.calls[1][0]);
    expect(parentSql).toContain("FROM compose_session_sources");
    expect(parentSql).toContain("deleted_at IS NULL");
    expect(parentSql).toContain("FOR UPDATE");
    expect(connection.query.mock.calls[1][1]).toEqual([7, 12, 13]);
    const sql = String(connection.query.mock.calls[2][0]);
    expect(sql).toContain("INSERT INTO compose_session_sources");
    expect(sql).toContain("'generated_research'");
    expect(sql).toContain("source_origin");
    expect(sql).toContain("generated_by_task_id");
    expect(sql).toContain("parent_source_ids_json");
    expect(sql).toContain("artifact_sha256");
    const params = connection.query.mock.calls[2][1] as unknown[];
    expect(params.slice(0, 4)).toEqual([
      7,
      null,
      "code-research.md",
      "# Research\n\nRepository: billing-service",
    ]);
    expect(params.slice(8, 16)).toEqual([
      501,
      JSON.stringify([12, 13]),
      4,
      JSON.stringify({ repositories: ["billing-service"] }),
      "high",
      "s3://bucket/compose/7/generated/code-research.md",
      "a".repeat(64),
      2048,
    ]);
    expect(connection.commit).toHaveBeenCalledOnce();
  });

  it("createGeneratedResearchSource rejects when the session is missing or archived", async () => {
    const connection = transactionalConnection();
    connection.query.mockResolvedValueOnce([[], []]);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(
      repo.createGeneratedResearchSource({
        sessionId: 7,
        generatedByTaskId: 501,
        originalFilename: "code-research.md",
        markdownContent: "# Research",
        artifactUri: "s3://bucket/compose/7/generated/code-research.md",
        artifactSha256: "a".repeat(64),
        artifactBytes: 2048,
        parentSourceIds: [],
        contextVersionUsed: 4,
        evidence: [],
        confidence: "medium",
      }),
    ).rejects.toThrow("Compose session 7 was not found");
    expect(connection.rollback).toHaveBeenCalledOnce();
  });

  it("createGeneratedResearchSource rejects deleted parent sources", async () => {
    const connection = transactionalConnection();
    connection.query
      .mockResolvedValueOnce([[{ id: 7 }], []])
      .mockResolvedValueOnce([[{ id: 12 }], []]);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(
      repo.createGeneratedResearchSource({
        sessionId: 7,
        generatedByTaskId: 501,
        originalFilename: "code-research.md",
        markdownContent: "# Research",
        artifactUri: "s3://bucket/compose/7/generated/code-research.md",
        artifactSha256: "a".repeat(64),
        artifactBytes: 2048,
        parentSourceIds: [12, 13],
        contextVersionUsed: 4,
        evidence: [],
        confidence: "medium",
      }),
    ).rejects.toThrow("generated_research_parent_source_unavailable");
    expect(connection.query).toHaveBeenCalledTimes(2);
    expect(connection.rollback).toHaveBeenCalledOnce();
  });

  it("getGeneratedResearchSourceByTaskId reads the generated source idempotency row", async () => {
    const query = vi.fn().mockResolvedValueOnce([
      [
        {
          id: 61,
          session_id: 7,
          kind: "generated_research",
          original_filename: "code-research.md",
          mime_type: null,
          size_bytes: null,
          source_url: null,
          s3_key_raw: null,
          converter: "none",
          markdown_path: null,
          markdown_content: "# Research",
          source_summary: "Research",
          source_entities_json: "{}",
          source_usefulness: "specific_evidence",
          source_contribution: "Research summary.",
          source_origin: "agent",
          generated_by_task_id: 501,
          parent_source_ids_json: "[12]",
          context_version_used: 4,
          evidence_json: "[]",
          confidence: "high",
          artifact_uri: "s3://bucket/compose/7/generated/code-research.md",
          artifact_sha256: "a".repeat(64),
          artifact_bytes: 2048,
          conversion_status: "converted",
          conversion_started_at: null,
          conversion_attempts: 0,
          conversion_lease_expires_at: null,
          error_message: null,
          created_at: new Date("2026-07-05T10:00:00.000Z"),
          updated_at: new Date("2026-07-05T10:00:00.000Z"),
        },
      ],
      [],
    ]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);

    await expect(repo.getGeneratedResearchSourceByTaskId(501)).resolves.toEqual(
      expect.objectContaining({
        id: 61,
        generatedByTaskId: 501,
        artifactUri: "s3://bucket/compose/7/generated/code-research.md",
      }),
    );

    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("FROM compose_session_sources");
    expect(sql).toContain("generated_by_task_id = ?");
    expect(sql).toContain("kind = 'generated_research'");
    expect(sql).toContain("LIMIT 1");
    expect(query.mock.calls[0][1]).toEqual([501]);
  });

  it("createReadyContextPatch stores a ready patch and marks context patch-ready", async () => {
    const connection = transactionalConnection();
    connection.query
      .mockResolvedValueOnce([[{ id: 7 }], []])
      .mockResolvedValueOnce([[{ id: 61 }], []])
      .mockResolvedValueOnce([{ insertId: 701, affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(
      repo.createReadyContextPatch({
        sessionId: 7,
        sourceId: 61,
        agentTaskId: 501,
        baseContextVersion: 4,
        patch: {
          facts: [{ text: "Billing service owns invoice exports." }],
        },
        patchUri: "s3://bucket/compose/7/context/patch-701.json",
        artifactSha256: "b".repeat(64),
        artifactBytes: 1024,
      }),
    ).resolves.toBe(701);

    const selectSql = String(connection.query.mock.calls[0][0]);
    expect(selectSql).toContain("FROM compose_sessions");
    expect(selectSql).toContain("status <> 'archived'");
    expect(selectSql).toContain("FOR UPDATE");
    expect(connection.query.mock.calls[0][1]).toEqual([7]);

    const sourceSql = String(connection.query.mock.calls[1][0]);
    expect(sourceSql).toContain("FROM compose_session_sources");
    expect(sourceSql).toContain("deleted_at IS NULL");
    expect(connection.query.mock.calls[1][1]).toEqual([61, 7]);

    const insertSql = String(connection.query.mock.calls[2][0]);
    expect(insertSql).toContain("INSERT INTO compose_context_patches");
    expect(insertSql).toContain("'ready'");
    expect(insertSql).toContain("patch_json");
    expect(connection.query.mock.calls[2][1]).toEqual([
      7,
      61,
      null,
      501,
      null,
      4,
      4,
      "source_distillation",
      null,
      "[]",
      "s3://bucket/compose/7/context/patch-701.json",
      "b".repeat(64),
      1024,
      JSON.stringify({
        facts: [{ text: "Billing service owns invoice exports." }],
      }),
    ]);

    const updateSql = String(connection.query.mock.calls[3][0]);
    expect(updateSql).toContain("UPDATE compose_sessions");
    expect(updateSql).toContain("context_status = 'patch_ready'");
    expect(updateSql).toContain("status <> 'archived'");
    expect(connection.query.mock.calls[3][1]).toEqual([7]);
    expect(connection.commit).toHaveBeenCalledOnce();
  });

  it("createReadyContextPatch rejects archived sessions before inserting", async () => {
    const connection = transactionalConnection();
    connection.query.mockResolvedValueOnce([[], []]);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(
      repo.createReadyContextPatch({
        sessionId: 7,
        sourceId: 61,
        agentTaskId: 501,
        baseContextVersion: 4,
        patch: { facts: [] },
      }),
    ).rejects.toThrow("Compose session 7 was not found");

    expect(connection.query).toHaveBeenCalledTimes(1);
    expect(String(connection.query.mock.calls[0][0])).toContain("FOR UPDATE");
    expect(String(connection.query.mock.calls[0][0])).toContain(
      "status <> 'archived'",
    );
    expect(connection.commit).toHaveBeenCalledOnce();
  });

  it("enqueueContextMergeTaskIfNeeded locks the session and creates one merge task", async () => {
    const connection = transactionalConnection();
    connection.query
      .mockResolvedValueOnce([[{ id: 7 }], []])
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([{ insertId: 801, affectedRows: 1 }, []]);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(
      repo.enqueueContextMergeTaskIfNeeded({
        sessionId: 7,
        triggerPatchId: 701,
      }),
    ).resolves.toBe(801);

    const sessionLockSql = String(connection.query.mock.calls[0][0]);
    expect(sessionLockSql).toContain("FOR UPDATE");
    expect(sessionLockSql).toContain("EXISTS");
    expect(sessionLockSql).toContain("compose_context_patches ready_patch");
    expect(sessionLockSql).toContain("ready_patch.status = 'ready'");
    expect(String(connection.query.mock.calls[1][0])).toContain(
      "capability = 'context_merge'",
    );
    expect(String(connection.query.mock.calls[1][0])).toContain(
      "status IN ('queued', 'running')",
    );
    expect(String(connection.query.mock.calls[2][0])).toContain(
      "INSERT INTO compose_agent_tasks",
    );
    expect(connection.query.mock.calls[2][1]).toEqual([
      7,
      "context_merge",
      "context_merge",
      null,
      90,
      JSON.stringify({ sessionId: 7, triggerPatchId: 701 }),
      3,
    ]);
    expect(String(connection.query.mock.calls[3][0])).toContain(
      "INSERT INTO spec_factory_outbox",
    );
    expect(connection.query.mock.calls[3][1]).toEqual(
      expect.arrayContaining([
        "agent_task",
        "801",
        "task.queued",
        "agent-task:801:queued:g1",
      ]),
    );
    expect(connection.commit).toHaveBeenCalledOnce();
  });

  it("recovers bounded patch-ready sessions that lost their context merge task", async () => {
    const connection = transactionalConnection();
    connection.query
      .mockResolvedValueOnce([[{ id: 7 }], []])
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([{ insertId: 801, affectedRows: 1 }, []]);
    const query = vi.fn().mockResolvedValueOnce([[{ id: 7 }], []]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(
      repo.recoverStrandedContextMerges({ limit: 25 }),
    ).resolves.toEqual({ inspected: 1, queued: 1 });

    const recoverySql = String(query.mock.calls[0][0]);
    expect(recoverySql).toContain("session.context_status = 'patch_ready'");
    expect(recoverySql).toContain("ready_patch.status = 'ready'");
    expect(recoverySql).toContain("status IN ('queued', 'running')");
    expect(recoverySql).toContain("recent_failure.status = 'failed'");
    expect(query.mock.calls[0][1]).toEqual([25]);
    expect(String(connection.query.mock.calls[3][0])).toContain(
      "INSERT INTO spec_factory_outbox",
    );
  });

  it("does not enqueue a context merge when no ready patch exists", async () => {
    const connection = transactionalConnection();
    connection.query.mockResolvedValueOnce([[], []]);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(
      repo.enqueueContextMergeTaskIfNeeded({ sessionId: 7 }),
    ).resolves.toBeNull();

    expect(connection.query).toHaveBeenCalledTimes(1);
    const sessionLockSql = String(connection.query.mock.calls[0][0]);
    expect(sessionLockSql).toContain("compose_context_patches ready_patch");
    expect(sessionLockSql).toContain("ready_patch.status = 'ready'");
    expect(connection.commit).toHaveBeenCalledOnce();
  });

  it("enqueueContextMergeTaskIfNeeded coalesces an existing queued merge task", async () => {
    const connection = transactionalConnection();
    connection.query
      .mockResolvedValueOnce([[{ id: 7 }], []])
      .mockResolvedValueOnce([[{ id: 800 }], []]);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(
      repo.enqueueContextMergeTaskIfNeeded({
        sessionId: 7,
        triggerPatchId: 701,
      }),
    ).resolves.toBeNull();

    expect(connection.query).toHaveBeenCalledTimes(2);
    expect(connection.commit).toHaveBeenCalledOnce();
  });

  it("beginContextVersionBuild reserves the next version and marks context building", async () => {
    const connection = transactionalConnection();
    connection.query
      .mockResolvedValueOnce([[{ id: 7, latest_context_version: 4 }], []])
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([{ insertId: 901, affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(
      repo.beginContextVersionBuild({
        sessionId: 7,
        createdByTaskId: 801,
      }),
    ).resolves.toEqual({
      contextVersionId: 901,
      version: 5,
      parentVersion: 4,
    });

    expect(String(connection.query.mock.calls[0][0])).toContain("FOR UPDATE");
    expect(String(connection.query.mock.calls[1][0])).toContain(
      "FROM compose_context_versions",
    );
    expect(String(connection.query.mock.calls[2][0])).toContain(
      "INSERT INTO compose_context_versions",
    );
    expect(connection.query.mock.calls[2][1]).toEqual([7, 5, 4, 801]);
    expect(String(connection.query.mock.calls[3][0])).toContain(
      "context_status = 'building'",
    );
    expect(connection.commit).toHaveBeenCalledOnce();
  });

  it("beginContextVersionBuild skips existing uncommitted version numbers", async () => {
    const connection = transactionalConnection();
    connection.query
      .mockResolvedValueOnce([[{ id: 7, latest_context_version: 4 }], []])
      .mockResolvedValueOnce([[{ version: 5 }], []])
      .mockResolvedValueOnce([{ insertId: 902, affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(
      repo.beginContextVersionBuild({
        sessionId: 7,
        createdByTaskId: 801,
      }),
    ).resolves.toEqual({
      contextVersionId: 902,
      version: 6,
      parentVersion: 4,
    });

    expect(connection.query.mock.calls[2][1]).toEqual([7, 6, 4, 801]);
    expect(connection.commit).toHaveBeenCalledOnce();
  });

  it("failContextVersionBuild marks the build failed and restores patch-ready state", async () => {
    const connection = transactionalConnection();
    connection.query
      .mockResolvedValueOnce([[{ id: 7 }], []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(
      repo.failContextVersionBuild({
        sessionId: 7,
        contextVersionId: 901,
        version: 5,
        errorMessage: "context_section_limit_exceeded:facts",
      }),
    ).resolves.toBe(true);

    expect(String(connection.query.mock.calls[0][0])).toContain("FOR UPDATE");
    expect(String(connection.query.mock.calls[1][0])).toContain(
      "status = 'failed'",
    );
    expect(connection.query.mock.calls[1][1]).toEqual([
      "context_section_limit_exceeded:facts",
      901,
      7,
      5,
    ]);
    const sessionSql = String(connection.query.mock.calls[2][0]);
    expect(sessionSql).toContain("THEN 'patch_ready'");
    expect(sessionSql).toContain("THEN 'clean'");
    expect(sessionSql).toContain("ELSE 'dirty'");
    expect(sessionSql).toContain("active_build.status = 'building'");
    expect(connection.commit).toHaveBeenCalledOnce();
  });

  it("commitContextVersion commits artifacts and updates the latest pointer monotonically", async () => {
    const connection = transactionalConnection();
    connection.query
      .mockResolvedValueOnce([[{ id: 7 }], []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ affectedRows: 2 }, []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(
      repo.commitContextVersion({
        sessionId: 7,
        contextVersionId: 901,
        version: 5,
        artifactUri: "s3://bucket/compose/7/context/working-context-v5.md",
        structuredArtifactUri:
          "s3://bucket/compose/7/context/working-context-v5.json",
        summary: { objective: "Build invoice export" },
        facts: [{ text: "Billing service owns invoice exports." }],
        openQuestions: [],
        conflicts: [{ text: "Billing vs Finance ownership conflict." }],
        decisions: [],
        sourceIds: [61],
        patchIds: [701, 702],
        artifactSha256: "c".repeat(64),
        artifactBytes: 4096,
      }),
    ).resolves.toBe(true);

    const selectSql = String(connection.query.mock.calls[0][0]);
    expect(selectSql).toContain("FROM compose_sessions");
    expect(selectSql).toContain("status <> 'archived'");
    expect(selectSql).toContain("FOR UPDATE");
    expect(connection.query.mock.calls[0][1]).toEqual([7]);

    expect(String(connection.query.mock.calls[1][0])).toContain(
      "status = 'committed'",
    );
    expect(String(connection.query.mock.calls[2][0])).toContain(
      "UPDATE compose_context_patches",
    );
    expect(String(connection.query.mock.calls[2][0])).toContain(
      "status = 'superseded'",
    );
    const latestSql = String(connection.query.mock.calls[3][0]);
    expect(latestSql).toContain("latest_context_version = ?");
    expect(latestSql).toContain(
      "(latest_context_version IS NULL OR latest_context_version < ?)",
    );
    expect(latestSql).toContain("context_status = CASE");
    expect(latestSql).toContain("FROM compose_context_patches ready_patch");
    expect(latestSql).toContain("ready_patch.status = 'ready'");
    expect(connection.commit).toHaveBeenCalledOnce();
  });

  it("commitContextVersion rejects archived sessions before committing a version", async () => {
    const connection = transactionalConnection();
    connection.query.mockResolvedValueOnce([[], []]);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(
      repo.commitContextVersion({
        sessionId: 7,
        contextVersionId: 901,
        version: 5,
        artifactUri: "s3://bucket/compose/7/context/working-context-v5.md",
        structuredArtifactUri:
          "s3://bucket/compose/7/context/working-context-v5.json",
        patchIds: [701],
        artifactSha256: "c".repeat(64),
        artifactBytes: 4096,
      }),
    ).resolves.toBe(false);

    expect(connection.query).toHaveBeenCalledTimes(1);
    expect(String(connection.query.mock.calls[0][0])).toContain("FOR UPDATE");
    expect(String(connection.query.mock.calls[0][0])).toContain(
      "status <> 'archived'",
    );
    expect(connection.commit).toHaveBeenCalledOnce();
  });

  it("getLatestContextProjection returns the newest committed context snapshot", async () => {
    const query = vi.fn().mockResolvedValueOnce([
      [
        {
          session_id: 7,
          version: 5,
          artifact_uri: "s3://bucket/compose/7/context/working-context-v5.md",
          structured_artifact_uri:
            "s3://bucket/compose/7/context/working-context-v5.json",
          summary_json: JSON.stringify({
            objective: "Build invoice export",
            problemStatement: "Users need exports for billing audits.",
            recommendedNextActions: ["Inspect billing-service export flow"],
          }),
          facts_json: JSON.stringify([
            { text: "Billing service owns invoice exports." },
          ]),
          open_questions_json: JSON.stringify([
            { question: "Which date range should exports support?" },
          ]),
          conflicts_json: JSON.stringify([
            { text: "Billing vs Finance ownership conflict." },
          ]),
          decisions_json: JSON.stringify([{ decision: "Use CSV first" }]),
          source_ids_json: JSON.stringify([61]),
          patch_ids_json: JSON.stringify([701, 702]),
          committed_at: "2026-07-05T10:30:00.000Z",
        },
      ],
      [],
    ]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);

    await expect(repo.getLatestContextProjection(7)).resolves.toEqual({
      sessionId: 7,
      version: 5,
      artifactUri: "s3://bucket/compose/7/context/working-context-v5.md",
      structuredArtifactUri:
        "s3://bucket/compose/7/context/working-context-v5.json",
      summary: {
        objective: "Build invoice export",
        problemStatement: "Users need exports for billing audits.",
        solution: null,
        businessRequirements: [],
        functionalRequirements: [],
        challenges: [],
        stories: [],
        recommendedNextActions: ["Inspect billing-service export flow"],
      },
      facts: [{ text: "Billing service owns invoice exports." }],
      implementationFindings: [],
      requirements: [],
      constraints: [],
      openQuestions: [{ question: "Which date range should exports support?" }],
      conflicts: [{ text: "Billing vs Finance ownership conflict." }],
      decisions: [{ decision: "Use CSV first" }],
      risks: [],
      sourceIds: [61],
      patchIds: [701, 702],
      committedAt: "2026-07-05T10:30:00.000Z",
    });

    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("FROM compose_context_versions");
    expect(sql).toContain("status = 'committed'");
    expect(sql).toContain("ORDER BY version DESC");
    expect(query.mock.calls[0][1]).toEqual([7]);
  });

  it("listReadyContextPatches returns ready patches ordered by creation", async () => {
    const query = vi.fn().mockResolvedValueOnce([
      [
        {
          id: 701,
          session_id: 7,
          source_id: 61,
          agent_task_id: 501,
          base_context_version: 4,
          patch_uri: "file:///workspace/context/patches/source-61.json",
          artifact_sha256: "b".repeat(64),
          artifact_bytes: 512,
          patch_json: JSON.stringify({
            facts: [{ text: "Billing export research" }],
          }),
          created_at: "2026-07-05T10:00:00.000Z",
          updated_at: "2026-07-05T10:00:01.000Z",
        },
      ],
      [],
    ]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);

    await expect(repo.listReadyContextPatches(7)).resolves.toEqual([
      {
        id: 701,
        sessionId: 7,
        sourceId: 61,
        agentTaskId: 501,
        baseContextVersion: 4,
        patchUri: "file:///workspace/context/patches/source-61.json",
        artifactSha256: "b".repeat(64),
        artifactBytes: 512,
        patch: { facts: [{ text: "Billing export research" }] },
        createdAt: "2026-07-05T10:00:00.000Z",
        updatedAt: "2026-07-05T10:00:01.000Z",
      },
    ]);

    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("FROM compose_context_patches");
    expect(sql).toContain("status = 'ready'");
    expect(sql).toContain("ORDER BY created_at ASC, id ASC");
    expect(query.mock.calls[0][1]).toEqual([7]);
  });

  it("listSessionSourceContents reads markdown_content for converted sources", async () => {
    const query = vi.fn().mockResolvedValueOnce([
      [
        {
          id: 12,
          original_filename: "note-1.md",
          markdown_content: "Repo is billing-service.",
        },
        {
          id: 13,
          original_filename: "spec.pdf",
          markdown_content: "# Spec\n\nDetails.",
        },
      ],
      [],
    ]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);
    const sources = await repo.listSessionSourceContents(3);
    expect(sources).toEqual([
      {
        sourceId: 12,
        filename: "note-1.md",
        content: "Repo is billing-service.",
      },
      { sourceId: 13, filename: "spec.pdf", content: "# Spec\n\nDetails." },
    ]);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("markdown_content");
    expect(sql).not.toContain("[[source:");
  });

  it("createUploadSource inserts an awaiting_upload file source and returns id", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([{ insertId: 21, affectedRows: 1 }, []]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);
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
    expect(sql).toContain("FROM compose_sessions");
    expect(sql).toContain("status <> 'archived'");
    expect(sql).toContain("'file'");
    expect(sql).toContain("'awaiting_upload'");
  });

  it("markSourceUploaded flips an awaiting_upload row to pending", async () => {
    const query = vi.fn().mockResolvedValueOnce([{ affectedRows: 1 }, []]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);
    await repo.markSourceUploaded({ sessionId: 4, sourceId: 21 });
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("UPDATE compose_session_sources");
    expect(sql).toContain("conversion_status = 'pending'");
    expect(sql).toContain("session_id = ?");
    expect(sql).toContain("conversion_status = 'awaiting_upload'");
    expect(sql).toContain("EXISTS");
    expect(sql).toContain("status <> 'archived'");
    expect(query.mock.calls[0][1]).toEqual([null, 21, 4]);
  });

  it("markSourceUploaded rejects a source outside the session", async () => {
    const query = vi.fn().mockResolvedValueOnce([{ affectedRows: 0 }, []]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);

    await expect(
      repo.markSourceUploaded({ sessionId: 4, sourceId: 21 }),
    ).rejects.toThrow("Compose source 21 was not found in session 4");
  });

  it("claimNextPendingSource atomically flips one pending row to converting", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([
        [
          {
            id: 7,
            session_id: 4,
            queued_at: "2026-06-02T00:00:01.000Z",
          },
        ],
        [],
      ])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])
      .mockResolvedValueOnce([
        [
          {
            id: 7,
            session_id: 4,
            request_id: "request-conversion-7",
            kind: "file",
            original_filename: "spec.pdf",
            mime_type: "application/pdf",
            size_bytes: 2048,
            source_url: null,
            s3_key_raw: "k",
            converter: "markitdown",
            markdown_path: null,
            markdown_content: null,
            conversion_status: "converting",
            error_message: null,
            created_at: "2026-06-02T00:00:00.000Z",
            updated_at: "2026-06-02T00:00:00.000Z",
          },
        ],
        [],
      ]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);
    const claimed = await repo.claimNextPendingSource();
    expect(claimed?.id).toBe(7);
    expect(claimed?.conversionStatus).toBe("converting");
    expect(claimed?.requestId).toBe("request-conversion-7");
    expect(claimed?.conversionQueuedAt).toBe("2026-06-02T00:00:01.000Z");
    const selectSql = String(query.mock.calls[0][0]);
    const updateSql = String(query.mock.calls[1][0]);
    expect(selectSql).toContain("compose_sessions");
    expect(selectSql).toContain("status <> 'archived'");
    expect(updateSql).toContain("conversion_status = 'converting'");
    expect(updateSql).toContain("conversion_started_at = CURRENT_TIMESTAMP(3)");
    expect(updateSql).toContain(
      "conversion_attempts = conversion_attempts + 1",
    );
    expect(updateSql).toContain("conversion_lease_expires_at = DATE_ADD");
    expect(updateSql).toContain("WHERE id = ?");
    expect(updateSql).toContain("EXISTS");
    expect(updateSql).toContain("status <> 'archived'");
    expect(updateSql).toContain("conversion_status = 'pending'");
  });

  it("claimNextPendingSource leaves fresh converting rows unclaimed", async () => {
    const query = vi.fn().mockResolvedValueOnce([[], []]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);

    await expect(repo.claimNextPendingSource()).resolves.toBeNull();

    const selectSql = String(query.mock.calls[0][0]);
    expect(selectSql).toContain("conversion_status = 'pending'");
    expect(selectSql).toContain("conversion_status = 'converting'");
    expect(selectSql).toContain(
      "conversion_lease_expires_at < CURRENT_TIMESTAMP(3)",
    );
  });

  it("claimNextPendingSource reclaims stale converting rows", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([
        [
          {
            id: 7,
            session_id: 4,
            queued_at: "2026-06-02T00:09:59.000Z",
          },
        ],
        [],
      ])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])
      .mockResolvedValueOnce([
        [
          {
            id: 7,
            session_id: 4,
            request_id: "request-conversion-7",
            kind: "file",
            original_filename: "spec.pdf",
            mime_type: "application/pdf",
            size_bytes: 2048,
            source_url: null,
            s3_key_raw: "k",
            converter: "markitdown",
            markdown_path: null,
            markdown_content: null,
            conversion_status: "converting",
            error_message: null,
            created_at: "2026-06-02T00:00:00.000Z",
            updated_at: "2026-06-02T00:00:00.000Z",
          },
        ],
        [],
      ]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);

    const claimed = await repo.claimNextPendingSource({ leaseMs: 600_000 });

    expect(claimed?.id).toBe(7);
    const selectSql = String(query.mock.calls[0][0]);
    const updateSql = String(query.mock.calls[1][0]);
    expect(selectSql).toContain(
      "conversion_lease_expires_at < CURRENT_TIMESTAMP(3)",
    );
    expect(updateSql).toContain(
      "conversion_lease_expires_at < CURRENT_TIMESTAMP(3)",
    );
    expect(query.mock.calls[1][1]).toEqual([600, 7]);
  });

  it("claimNextPendingSource returns null when the row was raced away", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([[{ id: 7, session_id: 4 }], []])
      .mockResolvedValueOnce([{ affectedRows: 0 }, []]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);
    expect(await repo.claimNextPendingSource()).toBeNull();
  });

  it("markSourceConverted writes markdown_content + markdown_path and status", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([
        [
          {
            id: 7,
            session_id: 4,
            kind: "file",
            original_filename: "spec.pdf",
            mime_type: "application/pdf",
            size_bytes: 1234,
            source_url: null,
            s3_key_raw: "compose/4/sources/spec.pdf",
            converter: "markitdown",
            markdown_path: null,
            markdown_content: null,
            source_summary: null,
            source_entities_json: null,
            source_usefulness: null,
            source_contribution: null,
            conversion_status: "converting",
            conversion_started_at: null,
            conversion_attempts: 1,
            conversion_lease_expires_at: null,
            error_message: null,
            created_at: "2026-06-02T00:00:00.000Z",
            updated_at: "2026-06-02T00:00:00.000Z",
          },
        ],
        [],
      ])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);
    await repo.markSourceConverted({
      sourceId: 7,
      markdownPath: "/w/sources/7-spec.pdf.md",
      markdownContent: "# Spec",
    });
    const sql = String(query.mock.calls[1][0]);
    expect(sql).toContain("conversion_status = 'converted'");
    expect(sql).toContain("conversion_started_at = NULL");
    expect(sql).toContain("conversion_lease_expires_at = NULL");
    expect(sql).toContain("markdown_content = ?");
    expect(sql).toContain("source_summary = ?");
    expect(sql).toContain("source_entities_json = CAST(? AS JSON)");
    expect(sql).toContain("EXISTS");
    expect(sql).toContain("compose_sessions");
    expect(sql).toContain("status <> 'archived'");
    expect(query.mock.calls[1][1]).toEqual([
      "/w/sources/7-spec.pdf.md",
      "# Spec",
      "Spec",
      JSON.stringify({
        jiraKeys: [],
        repositories: [],
        files: [],
        clients: [],
        loeHours: [],
        dates: [],
        assumptions: [],
      }),
      "weak_requirement_detail",
      "Too little detail to materially shape the draft.",
      7,
    ]);
  });

  it("completeSourceConversion atomically converts source and queues distillation", async () => {
    const connection = transactionalConnection();
    connection.query
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([{ insertId: 601, affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ affectedRows: 0 }, []])
      .mockResolvedValueOnce([{ insertId: 701, affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ insertId: 501, affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ insertId: 901, affectedRows: 1 }, []]);
    const payload = {
      capability: "source_distillation",
      executorType: "source_distillation",
      sourceId: 7,
      baseContextVersion: 3,
    };
    const query = vi.fn().mockResolvedValueOnce([
      [
        {
          id: 7,
          session_id: 4,
          kind: "file",
          original_filename: "spec.pdf",
          mime_type: "application/pdf",
          size_bytes: 1234,
          source_url: null,
          s3_key_raw: "compose/4/sources/spec.pdf",
          converter: "markitdown",
          markdown_path: null,
          markdown_content: null,
          source_summary: null,
          source_entities_json: null,
          source_usefulness: null,
          source_contribution: null,
          conversion_status: "converting",
          conversion_started_at: null,
          conversion_attempts: 1,
          conversion_lease_expires_at: null,
          error_message: null,
          created_at: "2026-06-02T00:00:00.000Z",
          updated_at: "2026-06-02T00:00:00.000Z",
        },
      ],
      [],
    ]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(
      repo.completeSourceConversion({
        sourceId: 7,
        markdownPath: "/w/sources/7-spec.pdf.md",
        markdownContent: "# Spec",
        distillationTask: {
          sessionId: 4,
          capability: "source_distillation",
          executorType: "source_distillation",
          input: { sourceId: 7, baseContextVersion: 3 },
          priority: 80,
          event: {
            eventType: "task.queued",
            payload,
            actorType: "system",
            actorId: "compose-conversion-worker",
            contextVersion: 3,
          },
        },
      }),
    ).resolves.toEqual({
      distillationAgentTaskId: 501,
      sourceRevisionId: 601,
      chunkCount: 1,
    });

    expect(connection.beginTransaction).toHaveBeenCalledOnce();
    const updateSql = String(connection.query.mock.calls[0][0]);
    expect(updateSql).toContain("UPDATE compose_session_sources");
    expect(updateSql).toContain("conversion_status = 'converted'");
    expect(updateSql).toContain("status <> 'archived'");

    const revisionSql = String(connection.query.mock.calls[2][0]);
    expect(revisionSql).toContain("INSERT INTO compose_source_revisions");
    const chunkSql = String(connection.query.mock.calls[4][0]);
    expect(chunkSql).toContain("INSERT INTO compose_source_chunks");

    const taskSql = String(connection.query.mock.calls[6][0]);
    expect(taskSql).toContain("INSERT INTO compose_agent_tasks");
    expect(taskSql).toContain("FROM compose_sessions");
    expect(taskSql).toContain("status <> 'archived'");
    expect(connection.query.mock.calls[6][1]).toEqual([
      4,
      null,
      "source_distillation",
      "source_distillation",
      null,
      80,
      JSON.stringify({
        sourceId: 7,
        baseContextVersion: 3,
        sourceRevisionId: 601,
        chunkCount: 1,
      }),
      3,
      null,
      4,
    ]);

    const eventSql = String(connection.query.mock.calls[7][0]);
    expect(eventSql).toContain("INSERT INTO compose_session_events");
    expect(eventSql).toContain("agent_task_id");
    expect(eventSql).toContain("context_version");
    expect(connection.query.mock.calls[7][1]).toEqual([
      4,
      "task.queued",
      null,
      JSON.stringify(payload),
      Buffer.byteLength(JSON.stringify(payload), "utf8"),
      "system",
      "compose-conversion-worker",
      null,
      null,
      501,
      3,
      4,
      "task.queued",
    ]);
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledOnce();
  });

  it("completeSourceConversion rolls back when the task event is not inserted", async () => {
    const connection = transactionalConnection();
    connection.query
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([{ insertId: 601, affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ affectedRows: 0 }, []])
      .mockResolvedValueOnce([{ insertId: 701, affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ insertId: 501, affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ insertId: 0, affectedRows: 0 }, []]);
    const query = vi.fn().mockResolvedValueOnce([
      [
        {
          id: 7,
          session_id: 4,
          kind: "file",
          original_filename: "spec.pdf",
          mime_type: "application/pdf",
          size_bytes: 1234,
          source_url: null,
          s3_key_raw: "compose/4/sources/spec.pdf",
          converter: "markitdown",
          markdown_path: null,
          markdown_content: null,
          source_summary: null,
          source_entities_json: null,
          source_usefulness: null,
          source_contribution: null,
          conversion_status: "converting",
          conversion_started_at: null,
          conversion_attempts: 1,
          conversion_lease_expires_at: null,
          error_message: null,
          created_at: "2026-06-02T00:00:00.000Z",
          updated_at: "2026-06-02T00:00:00.000Z",
        },
      ],
      [],
    ]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(
      repo.completeSourceConversion({
        sourceId: 7,
        markdownPath: "/w/sources/7-spec.pdf.md",
        markdownContent: "# Spec",
        distillationTask: {
          sessionId: 4,
          capability: "source_distillation",
          executorType: "source_distillation",
          input: { sourceId: 7, baseContextVersion: null },
          priority: 80,
          event: {
            eventType: "task.queued",
            payload: {
              capability: "source_distillation",
              executorType: "source_distillation",
              sourceId: 7,
              baseContextVersion: null,
            },
          },
        },
      }),
    ).rejects.toThrow("Compose session event task.queued was not inserted");
    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledOnce();
  });

  it("markSourceFailed and markSourceUnsupported set status + message", async () => {
    const query = vi.fn().mockResolvedValue([{ affectedRows: 1 }, []]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);
    await repo.markSourceFailed({ sourceId: 7, errorMessage: "boom" });
    expect(String(query.mock.calls[0][0])).toContain(
      "conversion_status = 'failed'",
    );
    expect(String(query.mock.calls[0][0])).toContain(
      "conversion_lease_expires_at = NULL",
    );
    expect(String(query.mock.calls[0][0])).toContain("EXISTS");
    expect(String(query.mock.calls[0][0])).toContain("status <> 'archived'");
    await repo.markSourceUnsupported({
      sourceId: 8,
      errorMessage: "audio not supported yet",
    });
    expect(String(query.mock.calls[1][0])).toContain(
      "conversion_status = 'unsupported'",
    );
    expect(String(query.mock.calls[1][0])).toContain(
      "conversion_lease_expires_at = NULL",
    );
    expect(String(query.mock.calls[1][0])).toContain("EXISTS");
    expect(String(query.mock.calls[1][0])).toContain("status <> 'archived'");
  });

  it("markSourceForRetry keeps the row converting with a future lease as the backoff gate", async () => {
    const query = vi.fn().mockResolvedValueOnce([{ affectedRows: 1 }, []]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);

    await repo.markSourceForRetry({
      sourceId: 7,
      errorMessage: "ThrottlingException",
      retryDelayMs: 60_000,
    });

    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("conversion_status = 'converting'");
    expect(sql).toContain("conversion_lease_expires_at =");
    expect(sql).toContain("DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL ? SECOND)");
    expect(sql).toContain("EXISTS");
    expect(sql).toContain("status <> 'archived'");
    // 60_000ms -> 60s gate, error recorded, scoped to the source id.
    expect(query.mock.calls[0][1]).toEqual([60, "ThrottlingException", 7]);
  });

  it("reconvertSource resets a failed/unsupported row to pending", async () => {
    const query = vi.fn().mockResolvedValueOnce([{ affectedRows: 1 }, []]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);
    await repo.reconvertSource({ sessionId: 4, sourceId: 9 });
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("conversion_status = 'pending'");
    expect(sql).toContain("session_id = ?");
    expect(sql).toContain("IN ('failed','unsupported')");
    expect(sql).toContain("EXISTS");
    expect(sql).toContain("status <> 'archived'");
    expect(query.mock.calls[0][1]).toEqual([null, 9, 4]);
  });

  it("reconvertFailedSessionSources resets all retryable rows in a session", async () => {
    const query = vi.fn().mockResolvedValueOnce([{ affectedRows: 3 }, []]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);

    await expect(repo.reconvertFailedSessionSources(4)).resolves.toBe(3);

    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("conversion_status = 'pending'");
    expect(sql).toContain("session_id = ?");
    expect(sql).toContain("IN ('failed','unsupported')");
    expect(sql).toContain("EXISTS");
    expect(sql).toContain("status <> 'archived'");
    expect(query.mock.calls[0][1]).toEqual([null, 4]);
  });

  it("getConversionQueueHealth summarizes status counts and queue ages", async () => {
    const query = vi.fn().mockResolvedValueOnce([
      [
        {
          conversion_status: "pending",
          count: "2",
          oldest_created_at: "2026-06-02T00:01:00.000Z",
          oldest_started_at: null,
        },
        {
          conversion_status: "awaiting_upload",
          count: 1,
          oldest_created_at: "2026-06-02T00:00:00.000Z",
          oldest_started_at: null,
        },
        {
          conversion_status: "converting",
          count: "3",
          oldest_created_at: "2026-06-02T00:02:00.000Z",
          oldest_started_at: "2026-06-02T00:03:00.000Z",
        },
        {
          conversion_status: "failed",
          count: "4",
          oldest_created_at: "2026-06-02T00:04:00.000Z",
          oldest_started_at: null,
        },
        {
          conversion_status: "unsupported",
          count: "1",
          oldest_created_at: "2026-06-02T00:05:00.000Z",
          oldest_started_at: null,
        },
      ],
    ]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);

    await expect(repo.getConversionQueueHealth()).resolves.toEqual({
      byStatus: {
        awaiting_upload: 1,
        pending: 2,
        converting: 3,
        converted: 0,
        unsupported: 1,
        failed: 4,
      },
      inFlight: 6,
      retryable: 5,
      oldestPendingAt: "2026-06-02T00:00:00.000Z",
      oldestConvertingAt: "2026-06-02T00:03:00.000Z",
    });

    expect(String(query.mock.calls[0][0])).toContain(
      "GROUP BY conversion_status",
    );
  });

  it("getControlPlaneHealth summarizes durable turns and agent tasks", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([
        [
          {
            status: "queued",
            count: "4",
            oldest_created_at: "2026-06-02T00:01:00.000Z",
            oldest_started_at: null,
            lease_expired: "0",
          },
          {
            status: "running",
            count: "2",
            oldest_created_at: "2026-06-02T00:02:00.000Z",
            oldest_started_at: "2026-06-02T00:03:00.000Z",
            lease_expired: "1",
          },
          {
            status: "waiting_on_research",
            count: "1",
            oldest_created_at: "2026-06-02T00:04:00.000Z",
            oldest_started_at: "2026-06-02T00:05:00.000Z",
            lease_expired: "0",
          },
          {
            status: "abandoned",
            count: "3",
            oldest_created_at: "2026-06-02T00:06:00.000Z",
            oldest_started_at: null,
            lease_expired: "2",
          },
        ],
      ])
      .mockResolvedValueOnce([
        [
          {
            status: "queued",
            count: "5",
            oldest_created_at: "2026-06-02T00:07:00.000Z",
            oldest_started_at: null,
            lease_expired: "0",
          },
          {
            status: "running",
            count: "2",
            oldest_created_at: "2026-06-02T00:08:00.000Z",
            oldest_started_at: "2026-06-02T00:09:00.000Z",
            lease_expired: "0",
          },
          {
            status: "completed",
            count: "13",
            oldest_created_at: "2026-06-02T00:10:00.000Z",
            oldest_started_at: null,
            lease_expired: "0",
          },
          {
            status: "abandoned",
            count: "2",
            oldest_created_at: "2026-06-02T00:11:00.000Z",
            oldest_started_at: null,
            lease_expired: "1",
          },
        ],
      ])
      .mockResolvedValueOnce([
        [
          {
            capability: "code_research",
            status: "queued",
            count: "3",
            oldest_created_at: "2026-06-02T00:16:00.000Z",
            oldest_started_at: null,
            lease_expired: "0",
          },
          {
            capability: "code_research",
            status: "running",
            count: "1",
            oldest_created_at: "2026-06-02T00:15:00.000Z",
            oldest_started_at: "2026-06-02T00:17:00.000Z",
            lease_expired: "0",
          },
          {
            capability: "code_research",
            status: "completed",
            count: "5",
            oldest_created_at: "2026-06-02T00:18:00.000Z",
            oldest_started_at: null,
            lease_expired: "0",
          },
          {
            capability: "code_research",
            status: "failed",
            count: "1",
            oldest_created_at: "2026-06-02T00:19:00.000Z",
            oldest_started_at: null,
            lease_expired: "1",
          },
          {
            capability: "critic_review",
            status: "completed",
            count: "8",
            oldest_created_at: "2026-06-02T00:20:00.000Z",
            oldest_started_at: null,
            lease_expired: "0",
          },
          {
            capability: "critic_review",
            status: "abandoned",
            count: "1",
            oldest_created_at: "2026-06-02T00:21:00.000Z",
            oldest_started_at: null,
            lease_expired: "0",
          },
        ],
      ])
      .mockResolvedValueOnce([
        [
          {
            calls_today: "7",
            failed_today: "2",
            input_tokens_today: "1200",
            output_tokens_today: "450",
            estimated_cost_usd_today: "1.234500",
            latest_call_at: "2026-06-02T00:12:00.000Z",
          },
        ],
      ])
      .mockResolvedValueOnce([
        [
          {
            purpose: "chat_coordinator_fast",
            calls_today: "4",
            failed_today: "1",
            input_tokens_today: "800",
            output_tokens_today: "300",
            estimated_cost_usd_today: "0.934500",
            latest_call_at: "2026-06-02T00:22:00.000Z",
          },
          {
            purpose: "critic_review",
            calls_today: "3",
            failed_today: "1",
            input_tokens_today: "400",
            output_tokens_today: "150",
            estimated_cost_usd_today: "0.300000",
            latest_call_at: "2026-06-02T00:23:00.000Z",
          },
        ],
      ])
      .mockResolvedValueOnce([
        [
          {
            mode: "worker",
            total: "2",
            live: "1",
            stale: "1",
            latest_heartbeat_at: "2026-06-02T00:13:00.000Z",
          },
          {
            mode: "research-worker",
            total: "1",
            live: "1",
            stale: "0",
            latest_heartbeat_at: "2026-06-02T00:14:00.000Z",
          },
          {
            mode: "turn-worker",
            total: "1",
            live: "1",
            stale: "0",
            latest_heartbeat_at: "2026-06-02T00:15:00.000Z",
          },
          {
            mode: "context-worker",
            total: "1",
            live: "1",
            stale: "0",
            latest_heartbeat_at: "2026-06-02T00:16:00.000Z",
          },
          {
            mode: "draft-worker",
            total: "1",
            live: "1",
            stale: "0",
            latest_heartbeat_at: "2026-06-02T00:17:00.000Z",
          },
          {
            mode: "relay-worker",
            total: "1",
            live: "1",
            stale: "0",
            latest_heartbeat_at: "2026-06-02T00:18:00.000Z",
          },
          {
            mode: "retention-worker",
            total: "1",
            live: "1",
            stale: "0",
            latest_heartbeat_at: "2026-06-02T00:19:00.000Z",
          },
        ],
      ])
      .mockResolvedValueOnce([
        [
          {
            turn_lease_fence_rejected: "5",
            agent_task_lease_fence_rejected: "4",
            turn_duplicate_suppressed_today: "6",
          },
        ],
      ])
      .mockResolvedValueOnce([
        [
          {
            context_version_used: "4",
            completed: "8",
            failed: "1",
            cancelled: "0",
            abandoned: "0",
            total: "9",
          },
          {
            context_version_used: null,
            completed: "2",
            failed: "0",
            cancelled: "1",
            abandoned: "0",
            total: "3",
          },
        ],
      ])
      .mockResolvedValueOnce([
        [
          {
            answer_today: "6",
            dispatch_research_today: "2",
            ask_clarification_today: "1",
            escalate_today: "1",
            rejected_today: "3",
            latest_decision_at: "2026-06-02T00:15:00.000Z",
          },
        ],
      ])
      .mockResolvedValueOnce([
        [
          {
            pending_workspace_cleanup: "6",
            failed_workspace_cleanup: "2",
            oldest_pending_archived_at: "2026-05-01T00:00:00.000Z",
            latest_cleanup_error_at: "2026-06-01T00:00:00.000Z",
            pending_llm_audit_artifacts: "4",
            oldest_pending_llm_audit_artifact_at: "2026-05-02T00:00:00.000Z",
          },
        ],
      ])
      .mockResolvedValueOnce([
        [
          {
            durable_published_today: "44",
            durable_persist_failures_today: "1",
            payload_too_large_today: "2",
            latest_published_at: "2026-06-02T00:27:00.000Z",
            latest_durable_error_at: "2026-06-02T00:24:00.000Z",
          },
        ],
      ])
      .mockResolvedValueOnce([
        [
          {
            active_tokens: "6",
            expired_unrevoked_tokens: "2",
            created_today: "9",
            revoked_today: "3",
            latest_created_at: "2026-06-02T00:28:00.000Z",
            latest_revoked_at: "2026-06-02T00:29:00.000Z",
          },
        ],
      ])
      .mockResolvedValueOnce([
        [
          {
            running_tasks: "2",
            completed_today: "7",
            failed_today: "1",
            avg_runtime_seconds_today: "42.5000",
            max_runtime_seconds_today: "120",
            oldest_running_started_at: "2026-06-02T00:18:00.000Z",
            latest_terminal_at: "2026-06-02T00:30:00.000Z",
          },
        ],
      ])
      .mockResolvedValueOnce([
        [
          {
            patches_ready: "4",
            patches_building: "1",
            patches_failed: "2",
            oldest_ready_patch_at: "2026-06-02T00:20:00.000Z",
            versions_committed_today: "6",
            versions_failed_today: "1",
            versions_building: "1",
            latest_committed_version_at: "2026-06-02T00:25:00.000Z",
            latest_failed_version_at: "2026-06-02T00:26:00.000Z",
          },
        ],
      ]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);

    await expect(repo.getControlPlaneHealth()).resolves.toMatchObject({
      turns: {
        byStatus: expect.objectContaining({
          queued: 4,
          running: 2,
          waiting_on_research: 1,
          abandoned: 3,
          completed: 0,
        }),
        durableQueued: 4,
        durableRunning: 3,
        durableAbandoned: 3,
        legacyInflight: 0,
        legacyQueued: 0,
        duplicateSuppressedToday: 6,
        leaseExpired: 3,
        leaseFenceRejected: 5,
        outcomesByContextVersionToday: [
          {
            contextVersionUsed: 4,
            completed: 8,
            failed: 1,
            cancelled: 0,
            abandoned: 0,
            total: 9,
          },
          {
            contextVersionUsed: null,
            completed: 2,
            failed: 0,
            cancelled: 1,
            abandoned: 0,
            total: 3,
          },
        ],
        oldestQueuedAt: "2026-06-02T00:01:00.000Z",
        oldestRunningAt: "2026-06-02T00:03:00.000Z",
      },
      agentTasks: {
        byStatus: expect.objectContaining({
          queued: 5,
          running: 2,
          completed: 13,
          abandoned: 2,
        }),
        queued: 5,
        running: 2,
        completed: 13,
        abandoned: 2,
        leaseExpired: 1,
        leaseFenceRejected: 4,
        byCapability: {
          code_research: {
            queued: 3,
            running: 1,
            completed: 5,
            failed: 1,
            cancelled: 0,
            abandoned: 0,
            total: 10,
            leaseExpired: 1,
            oldestQueuedAt: "2026-06-02T00:16:00.000Z",
            oldestRunningAt: "2026-06-02T00:17:00.000Z",
          },
          critic_review: {
            queued: 0,
            running: 0,
            completed: 8,
            failed: 0,
            cancelled: 0,
            abandoned: 1,
            total: 9,
            leaseExpired: 0,
            oldestQueuedAt: null,
            oldestRunningAt: null,
          },
        },
        oldestQueuedAt: "2026-06-02T00:07:00.000Z",
        oldestRunningAt: "2026-06-02T00:09:00.000Z",
      },
      llm: {
        callsToday: 7,
        failedToday: 2,
        inputTokensToday: 1200,
        outputTokensToday: 450,
        estimatedCostUsdToday: 1.2345,
        latestCallAt: "2026-06-02T00:12:00.000Z",
        byPurposeToday: {
          chat_coordinator_fast: {
            callsToday: 4,
            failedToday: 1,
            inputTokensToday: 800,
            outputTokensToday: 300,
            estimatedCostUsdToday: 0.9345,
            latestCallAt: "2026-06-02T00:22:00.000Z",
          },
          critic_review: {
            callsToday: 3,
            failedToday: 1,
            inputTokensToday: 400,
            outputTokensToday: 150,
            estimatedCostUsdToday: 0.3,
            latestCallAt: "2026-06-02T00:23:00.000Z",
          },
        },
      },
      workers: {
        total: 8,
        live: 7,
        stale: 1,
        byMode: expect.objectContaining({
          worker: {
            total: 2,
            live: 1,
            stale: 1,
            latestHeartbeatAt: "2026-06-02T00:13:00.000Z",
          },
          "research-worker": {
            total: 1,
            live: 1,
            stale: 0,
            latestHeartbeatAt: "2026-06-02T00:14:00.000Z",
          },
          "turn-worker": {
            total: 1,
            live: 1,
            stale: 0,
            latestHeartbeatAt: "2026-06-02T00:15:00.000Z",
          },
          "context-worker": {
            total: 1,
            live: 1,
            stale: 0,
            latestHeartbeatAt: "2026-06-02T00:16:00.000Z",
          },
          "draft-worker": {
            total: 1,
            live: 1,
            stale: 0,
            latestHeartbeatAt: "2026-06-02T00:17:00.000Z",
          },
          "relay-worker": {
            total: 1,
            live: 1,
            stale: 0,
            latestHeartbeatAt: "2026-06-02T00:18:00.000Z",
          },
          "retention-worker": {
            total: 1,
            live: 1,
            stale: 0,
            latestHeartbeatAt: "2026-06-02T00:19:00.000Z",
          },
        }),
      },
      coordinator: {
        decisionsToday: {
          answer: 6,
          dispatchResearch: 2,
          askClarification: 1,
          escalate: 1,
          rejected: 3,
        },
        latestDecisionAt: "2026-06-02T00:15:00.000Z",
      },
      retention: {
        pendingWorkspaceCleanup: 6,
        failedWorkspaceCleanup: 2,
        oldestPendingArchivedAt: "2026-05-01T00:00:00.000Z",
        latestCleanupErrorAt: "2026-06-01T00:00:00.000Z",
        pendingLlmAuditArtifacts: 4,
        oldestPendingLlmAuditArtifactAt: "2026-05-02T00:00:00.000Z",
      },
      events: {
        durablePublishedToday: 44,
        durablePersistFailuresToday: 1,
        payloadTooLargeToday: 2,
        latestPublishedAt: "2026-06-02T00:27:00.000Z",
        latestDurableErrorAt: "2026-06-02T00:24:00.000Z",
      },
      streamTokens: {
        activeTokens: 6,
        expiredUnrevokedTokens: 2,
        createdToday: 9,
        revokedToday: 3,
        latestCreatedAt: "2026-06-02T00:28:00.000Z",
        latestRevokedAt: "2026-06-02T00:29:00.000Z",
      },
      research: {
        runningTasks: 2,
        completedToday: 7,
        failedToday: 1,
        avgRuntimeSecondsToday: 42.5,
        maxRuntimeSecondsToday: 120,
        oldestRunningStartedAt: "2026-06-02T00:18:00.000Z",
        latestTerminalAt: "2026-06-02T00:30:00.000Z",
      },
      context: {
        patchesReady: 4,
        patchesBuilding: 1,
        patchesFailed: 2,
        oldestReadyPatchAt: "2026-06-02T00:20:00.000Z",
        versionsCommittedToday: 6,
        versionsFailedToday: 1,
        versionsBuilding: 1,
        latestCommittedVersionAt: "2026-06-02T00:25:00.000Z",
        latestFailedVersionAt: "2026-06-02T00:26:00.000Z",
      },
    });

    expect(String(query.mock.calls[0][0])).toContain("FROM compose_turn_jobs");
    expect(String(query.mock.calls[1][0])).toContain(
      "FROM compose_agent_tasks",
    );
    expect(String(query.mock.calls[2][0])).toContain(
      "FROM compose_agent_tasks",
    );
    expect(String(query.mock.calls[2][0])).toContain("capability");
    expect(String(query.mock.calls[2][0])).toContain(
      "GROUP BY capability, status",
    );
    expect(String(query.mock.calls[3][0])).toContain(
      "FROM spec_factory_llm_calls",
    );
    expect(String(query.mock.calls[3][0])).toContain("UTC_DATE()");
    expect(String(query.mock.calls[4][0])).toContain(
      "FROM spec_factory_llm_calls",
    );
    expect(String(query.mock.calls[4][0])).toContain("GROUP BY purpose");
    expect(String(query.mock.calls[4][0])).toContain("estimated_cost_usd");
    expect(String(query.mock.calls[5][0])).toContain(
      "FROM spec_factory_worker_heartbeats",
    );
    expect(String(query.mock.calls[5][0])).toContain("INTERVAL 45 SECOND");
    expect(String(query.mock.calls[6][0])).toContain(
      "FROM compose_session_events",
    );
    expect(String(query.mock.calls[6][0])).toContain(
      "turn.lease_fence_rejected",
    );
    expect(String(query.mock.calls[6][0])).toContain(
      "task.lease_fence_rejected",
    );
    expect(String(query.mock.calls[6][0])).toContain(
      "turn.duplicate_suppressed",
    );
    expect(String(query.mock.calls[7][0])).toContain("context_version_used");
    expect(String(query.mock.calls[7][0])).toContain("FROM compose_turn_jobs");
    expect(String(query.mock.calls[7][0])).toContain("UTC_DATE()");
    expect(String(query.mock.calls[8][0])).toContain(
      "FROM compose_session_events",
    );
    expect(String(query.mock.calls[8][0])).toContain("coordinatorAction");
    expect(String(query.mock.calls[8][0])).toContain("chat_coordinator");
    expect(String(query.mock.calls[9][0])).toContain("FROM compose_sessions");
    expect(String(query.mock.calls[9][0])).toContain("workspace_cleaned_at");
    expect(String(query.mock.calls[9][0])).toContain(
      "FROM spec_factory_llm_calls",
    );
    expect(String(query.mock.calls[9][0])).toContain("workspace_cleanup_error");
    expect(String(query.mock.calls[10][0])).toContain(
      "FROM compose_session_events",
    );
    expect(String(query.mock.calls[10][0])).toContain("event_persist_failed");
    expect(String(query.mock.calls[10][0])).toContain("payload_too_large");
    expect(String(query.mock.calls[11][0])).toContain(
      "FROM compose_stream_tokens",
    );
    expect(String(query.mock.calls[11][0])).toContain(
      "expired_unrevoked_tokens",
    );
    expect(String(query.mock.calls[12][0])).toContain(
      "FROM compose_agent_tasks",
    );
    expect(String(query.mock.calls[12][0])).toContain("TIMESTAMPDIFF");
    expect(String(query.mock.calls[12][0])).toContain("code_research");
    expect(String(query.mock.calls[13][0])).toContain(
      "FROM compose_context_patches",
    );
    expect(String(query.mock.calls[13][0])).toContain(
      "compose_context_versions",
    );
    expect(String(query.mock.calls[13][0])).toContain("UTC_DATE()");
  });

  it("reconvertSource rejects a source outside the session", async () => {
    const query = vi.fn().mockResolvedValueOnce([{ affectedRows: 0 }, []]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);

    await expect(
      repo.reconvertSource({ sessionId: 4, sourceId: 9 }),
    ).rejects.toThrow("Compose source 9 was not found in session 4");
  });

  it("deleteSessionSource soft-deletes a source and queues explicit context removal", async () => {
    const connection = transactionalConnection();
    connection.query.mockImplementation(async (sql: unknown) => {
      const statement = String(sql);
      if (statement.includes("FROM compose_sessions")) {
        return [[{ id: 4 }], []];
      }
      if (statement.includes("FROM compose_session_sources")) {
        return [
          [
            {
              id: 9,
              current_revision_id: 601,
              kind: "note",
              original_filename: "requirements.md",
              source_url: null,
              parent_source_ids_json: null,
              generated_by_task_id: null,
            },
            {
              id: 10,
              current_revision_id: 602,
              kind: "generated_research",
              original_filename: "research.md",
              source_url: null,
              parent_source_ids_json: "[9]",
              generated_by_task_id: 501,
            },
          ],
          [],
        ];
      }
      if (statement.includes("FROM compose_handoffs")) {
        return [[{ id: 31, source_id: null, draft_workflow_id: null }], []];
      }
      if (statement.includes("FROM compose_context_versions")) {
        return [[], []];
      }
      if (statement.includes("INSERT INTO compose_source_deletions")) {
        return [{ insertId: 801, affectedRows: 1 }, []];
      }
      if (statement.includes("INSERT INTO compose_context_patches")) {
        return [{ insertId: 701, affectedRows: 1 }, []];
      }
      return [{ insertId: 901, affectedRows: 1 }, []];
    });
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(
      repo.deleteSessionSource({
        sessionId: 4,
        sourceId: 9,
        actor: "person-1",
        undoWindowMinutes: 10,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        id: 801,
        sessionId: 4,
        sourceId: 9,
        sourceTitle: "requirements.md",
        status: "undoable",
        invalidatedSourceIds: [9, 10],
        invalidatedHandoffIds: [31],
        dependentSourceCount: 1,
      }),
    );

    const statements = connection.query.mock.calls.map((call) =>
      String(call[0]),
    );
    expect(statements[0]).toContain("FROM compose_sessions");
    expect(statements[1]).toContain("FROM compose_session_sources");
    expect(statements[1]).toContain("deleted_at IS NULL");
    expect(statements.some((sql) => sql.includes("'source_removal'"))).toBe(
      true,
    );
    expect(
      statements.some(
        (sql) =>
          sql.includes("deletion_id = ?") &&
          sql.includes("deleted_at = CURRENT_TIMESTAMP(3)"),
      ),
    ).toBe(true);
    expect(
      statements.some(
        (sql) =>
          sql.includes("capability = 'source_distillation'") &&
          sql.includes("JSON_OVERLAPS"),
      ),
    ).toBe(true);
    expect(
      statements.some(
        (sql) =>
          sql.includes("UPDATE compose_turn_jobs") &&
          sql.includes("error_code = 'source_deleted'"),
      ),
    ).toBe(true);
    expect(
      statements.some(
        (sql) =>
          sql.includes("INSERT INTO compose_agent_tasks") &&
          sql.includes("'context_merge'"),
      ),
    ).toBe(true);
    const outboxEventTypes = connection.query.mock.calls
      .filter((call) => String(call[0]).includes("spec_factory_outbox"))
      .map((call) => (call[1] as unknown[])[2]);
    expect(outboxEventTypes).toContain("source.deleted");
    expect(outboxEventTypes).toContain("source.invalidated");
    expect(outboxEventTypes).toContain("task.queued");
    expect(connection.commit).toHaveBeenCalledOnce();
  });

  it("deleteSessionSource returns null for a source outside the session", async () => {
    const connection = transactionalConnection();
    connection.query
      .mockResolvedValueOnce([[{ id: 4 }], []])
      .mockResolvedValueOnce([[], []]);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(
      repo.deleteSessionSource({ sessionId: 4, sourceId: 9 }),
    ).resolves.toBeNull();
    expect(connection.commit).toHaveBeenCalledOnce();
  });

  it("lists only active undo windows for deleted sources", async () => {
    const query = vi.fn().mockResolvedValueOnce([
      [
        {
          id: 801,
          session_id: 4,
          source_id: 9,
          source_title: "requirements.md",
          status: "undoable",
          undo_until: new Date("2026-07-11T12:10:00.000Z"),
          invalidated_source_ids_json: "[9,10]",
          invalidated_handoff_ids_json: "[31]",
          created_at: new Date("2026-07-11T12:00:00.000Z"),
        },
      ],
      [],
    ]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);

    await expect(repo.listUndoableSourceDeletions(4)).resolves.toEqual([
      {
        id: 801,
        sessionId: 4,
        sourceId: 9,
        sourceTitle: "requirements.md",
        status: "undoable",
        undoUntil: "2026-07-11T12:10:00.000Z",
        invalidatedSourceIds: [9, 10],
        invalidatedHandoffIds: [31],
        dependentSourceCount: 1,
        createdAt: "2026-07-11T12:00:00.000Z",
      },
    ]);
    expect(String(query.mock.calls[0][0])).toContain(
      "deletion.undo_until > CURRENT_TIMESTAMP(3)",
    );
    expect(String(query.mock.calls[0][0])).toContain(
      "source.deleted_at IS NOT NULL",
    );
  });

  it("restoreSessionSource restores only the original source and requeues distillation", async () => {
    const connection = transactionalConnection();
    connection.query.mockImplementation(async (sql: unknown) => {
      const statement = String(sql);
      if (
        statement.includes("SELECT id, latest_context_version") &&
        statement.includes("FROM compose_sessions")
      ) {
        return [[{ id: 4, latest_context_version: 5 }], []];
      }
      if (
        statement.includes("FROM compose_source_deletions deletion") &&
        statement.includes("current_revision_id")
      ) {
        return [
          [
            {
              id: 801,
              session_id: 4,
              source_id: 9,
              source_title: "requirements.md",
              status: "undoable",
              undo_until: new Date("2026-07-11T12:10:00.000Z"),
              invalidated_source_ids_json: "[9,10]",
              invalidated_handoff_ids_json: "[31]",
              created_at: new Date("2026-07-11T12:00:00.000Z"),
              current_revision_id: 601,
              conversion_status: "converted",
            },
          ],
          [],
        ];
      }
      if (statement.includes("INSERT INTO compose_agent_tasks")) {
        return [{ insertId: 501, affectedRows: 1 }, []];
      }
      return [{ insertId: 901, affectedRows: 1 }, []];
    });
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(
      repo.restoreSessionSource({
        sessionId: 4,
        sourceId: 9,
        actor: "person-1",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        id: 801,
        sourceId: 9,
        status: "restored",
        invalidatedSourceIds: [9, 10],
      }),
    );

    const sourceRestoreCall = connection.query.mock.calls.find((call) =>
      String(call[0]).includes("SET deleted_at = NULL"),
    );
    expect(sourceRestoreCall?.[1]).toEqual([9, 4, 801]);
    expect(String(sourceRestoreCall?.[0])).toContain("WHERE id = ?");
    expect(
      connection.query.mock.calls.some(
        (call) =>
          String(call[0]).includes("INSERT INTO compose_agent_tasks") &&
          String(call[0]).includes("'source_distillation'"),
      ),
    ).toBe(true);
    const eventTypes = connection.query.mock.calls
      .filter((call) => String(call[0]).includes("spec_factory_outbox"))
      .map((call) => (call[1] as unknown[])[2]);
    expect(eventTypes).toContain("source.restored");
    expect(eventTypes).toContain("task.queued");
    expect(connection.commit).toHaveBeenCalledOnce();
  });

  it("restoreSessionSource republishes conversion work for a pending source", async () => {
    const connection = transactionalConnection();
    connection.query.mockImplementation(async (sql: unknown) => {
      const statement = String(sql);
      if (statement.includes("SELECT id, latest_context_version")) {
        return [[{ id: 4, latest_context_version: 5 }], []];
      }
      if (
        statement.includes("FROM compose_source_deletions deletion") &&
        statement.includes("current_revision_id")
      ) {
        return [
          [
            {
              id: 801,
              session_id: 4,
              source_id: 9,
              source_title: "requirements.pdf",
              status: "undoable",
              undo_until: new Date("2026-07-11T12:10:00.000Z"),
              invalidated_source_ids_json: "[9]",
              invalidated_handoff_ids_json: "[]",
              created_at: new Date("2026-07-11T12:00:00.000Z"),
              current_revision_id: null,
              conversion_status: "pending",
            },
          ],
          [],
        ];
      }
      return [{ insertId: 901, affectedRows: 1 }, []];
    });
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await repo.restoreSessionSource({ sessionId: 4, sourceId: 9 });

    const outboxCalls = connection.query.mock.calls.filter((call) =>
      String(call[0]).includes("spec_factory_outbox"),
    );
    const conversionCall = outboxCalls.find(
      (call) => (call[1] as unknown[])[2] === "source.conversion.queued",
    );
    expect(conversionCall).toBeTruthy();
    expect((conversionCall?.[1] as unknown[])[4]).toBe(
      "source-conversion:9:restore:801",
    );
    expect(
      outboxCalls.some((call) => (call[1] as unknown[])[2] === "task.queued"),
    ).toBe(false);
  });

  it("claimNextSourceDeletionPurge includes only sources still deleted in the batch", async () => {
    const connection = transactionalConnection();
    connection.query
      .mockResolvedValueOnce([
        [
          {
            id: 801,
            session_id: 4,
            source_id: 9,
          },
        ],
        [],
      ])
      .mockResolvedValueOnce([[{ workspace_path: "/workspace/compose/4" }], []])
      .mockResolvedValueOnce([[{ id: 801 }], []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])
      .mockResolvedValueOnce([
        [
          {
            id: 10,
            s3_key_raw: "compose/4/raw/research.json",
            markdown_path: "/workspace/compose/4/sources/research.md",
            artifact_uri: "s3://artifacts/compose/4/research.json",
          },
        ],
        [],
      ])
      .mockResolvedValueOnce([
        [
          {
            artifact_uri:
              "file:///workspace/compose/4/sources/research-chunk.md",
          },
        ],
        [],
      ]);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(repo.claimNextSourceDeletionPurge()).resolves.toEqual({
      deletionId: 801,
      sessionId: 4,
      sourceId: 9,
      workspacePath: "/workspace/compose/4",
      sourceIds: [10],
      s3Keys: ["compose/4/raw/research.json"],
      artifactUris: [
        "s3://artifacts/compose/4/research.json",
        "file:///workspace/compose/4/sources/research-chunk.md",
      ],
      localPaths: ["/workspace/compose/4/sources/research.md"],
    });
    expect(String(connection.query.mock.calls[0][0])).toContain(
      "status IN ('undoable', 'restored')",
    );
    expect(String(connection.query.mock.calls[0][0])).toContain(
      "status = 'failed'",
    );
    expect(String(connection.query.mock.calls[0][0])).toContain(
      "INTERVAL 5 MINUTE",
    );
    expect(String(connection.query.mock.calls[0][0])).toContain(
      "status = 'purging'",
    );
    expect(String(connection.query.mock.calls[0][0])).toContain(
      "INTERVAL 15 MINUTE",
    );
    expect(String(connection.query.mock.calls[1][0])).toContain(
      "FROM compose_sessions",
    );
    expect(String(connection.query.mock.calls[1][0])).toContain("FOR UPDATE");
    expect(String(connection.query.mock.calls[4][0])).toContain(
      "deleted_at IS NOT NULL",
    );
    expect(connection.commit).toHaveBeenCalledOnce();
  });

  it("markSourceDeletionPurged scrubs deleted content and emits a session-scoped event", async () => {
    const connection = transactionalConnection();
    connection.query.mockImplementation(async (sql: unknown) => {
      if (String(sql).includes("SELECT id, session_id, source_id")) {
        return [[{ id: 801, session_id: 4, source_id: 9 }], []];
      }
      return [{ insertId: 901, affectedRows: 1 }, []];
    });
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(
      repo.markSourceDeletionPurged({
        deletionId: 801,
        deletedFileCount: 3,
        deletedObjectCount: 2,
      }),
    ).resolves.toBe(true);

    const statements = connection.query.mock.calls.map((call) =>
      String(call[0]),
    );
    expect(
      statements.some(
        (statement) =>
          statement.includes("UPDATE compose_source_chunks") &&
          statement.includes("content_text = ''"),
      ),
    ).toBe(true);
    expect(
      statements.some(
        (statement) =>
          statement.includes("UPDATE compose_session_sources") &&
          statement.includes("markdown_content = NULL") &&
          statement.includes("purged_at = CURRENT_TIMESTAMP(3)"),
      ),
    ).toBe(true);
    const outboxCall = connection.query.mock.calls.find((call) =>
      String(call[0]).includes("spec_factory_outbox"),
    );
    expect((outboxCall?.[1] as unknown[])[2]).toBe("source.purged");
    expect(JSON.parse(String((outboxCall?.[1] as unknown[])[5]))).toMatchObject(
      {
        sessionId: 4,
        sourceId: 9,
        deletionId: 801,
        deletedFileCount: 3,
        deletedObjectCount: 2,
      },
    );
    expect(connection.commit).toHaveBeenCalledOnce();
  });

  it("listMessages returns ordered session messages", async () => {
    const query = vi.fn().mockResolvedValueOnce([
      [
        {
          id: 1,
          session_id: 3,
          role: "assistant",
          content: "Which repo?",
          created_at: "2026-06-02T00:00:00.000Z",
        },
        {
          id: 2,
          session_id: 3,
          role: "user",
          content: "billing-service",
          created_at: "2026-06-02T00:01:00.000Z",
        },
      ],
      [],
    ]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);
    const msgs = await repo.listMessages(3);
    expect(msgs).toEqual([
      {
        id: 1,
        sessionId: 3,
        role: "assistant",
        content: "Which repo?",
        createdAt: "2026-06-02T00:00:00.000Z",
      },
      {
        id: 2,
        sessionId: 3,
        role: "user",
        content: "billing-service",
        createdAt: "2026-06-02T00:01:00.000Z",
      },
    ]);
    expect(String(query.mock.calls[0][0])).toContain(
      "FROM compose_session_messages",
    );
    expect(String(query.mock.calls[0][0])).toContain("ORDER BY id ASC");
  });

  it("getSessionWorkflowState reports background agent activity", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([[{ id: 3, context_status: "clean" }], []])
      .mockResolvedValueOnce([
        [
          {
            id: 101,
            turn_kind: "chat",
            status: "waiting_on_research",
            attempt_count: 1,
            max_attempts: 3,
            requested_context_version: 4,
            context_version_used: 4,
            queued_at: "2026-07-10T00:00:00.000Z",
            started_at: "2026-07-10T00:00:01.000Z",
            completed_at: null,
            clarification_expires_at: null,
            error_code: null,
            error_message: null,
            queue_position: null,
          },
        ],
        [],
      ])
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([
        [
          { capability: "code_research", status: "running", count: 2 },
          {
            capability: "source_distillation",
            status: "queued",
            count: 1,
          },
        ],
        [],
      ])
      .mockResolvedValueOnce([
        [{ conversion_status: "converting", count: 1 }],
        [],
      ]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);

    const state = await repo.getSessionWorkflowState(3);

    expect(state?.agents).toEqual([
      expect.objectContaining({
        key: "sources",
        status: "working",
        activeCount: 1,
      }),
      expect.objectContaining({
        key: "requirements",
        status: "working",
        activeCount: 1,
      }),
      expect.objectContaining({
        key: "research",
        status: "working",
        activeCount: 3,
      }),
      expect.objectContaining({
        key: "draft",
        status: "idle",
        activeCount: 0,
      }),
    ]);
    expect(String(query.mock.calls[3][0])).toContain(
      "FROM compose_agent_tasks",
    );
    expect(String(query.mock.calls[4][0])).toContain(
      "FROM compose_session_sources",
    );
    const turnSql = String(query.mock.calls[1][0]);
    expect(turnSql).toContain("turn.created_at AS queued_at");
    expect(turnSql).not.toContain("turn.queued_at");
    expect(turnSql).toContain("ahead.created_at < turn.created_at");
    expect(turnSql).not.toContain("ahead.priority");
  });

  it("reports an awaiting clarification as waiting rather than active requirements work", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([[{ id: 3, context_status: "patch_ready" }], []])
      .mockResolvedValueOnce([
        [
          {
            id: 101,
            turn_kind: "chat",
            status: "awaiting_user_input",
            attempt_count: 1,
            max_attempts: 3,
            requested_context_version: null,
            context_version_used: null,
            queued_at: "2026-07-10T00:00:00.000Z",
            started_at: "2026-07-10T00:00:01.000Z",
            completed_at: null,
            clarification_expires_at: "2026-07-11T00:00:00.000Z",
            error_code: null,
            error_message: null,
            queue_position: null,
          },
        ],
        [],
      ])
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([[], []]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);

    const state = await repo.getSessionWorkflowState(3);

    expect(state?.agents).toContainEqual(
      expect.objectContaining({
        key: "requirements",
        status: "waiting",
        detail: "Waiting for your answer",
        activeCount: 0,
      }),
    );
  });

  it("setClaudeSessionId updates the session", async () => {
    const query = vi.fn().mockResolvedValueOnce([{ affectedRows: 1 }, []]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);
    await repo.setClaudeSessionId({
      sessionId: 3,
      claudeSessionId: "sess-abc",
    });
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("UPDATE compose_sessions");
    expect(sql).toContain("claude_session_id = ?");
    expect(sql).toContain("status <> 'archived'");
    expect(query.mock.calls[0][1]).toEqual(["sess-abc", 3]);
  });

  it("setReadiness writes readiness_json and flips status to ready when ready", async () => {
    const query = vi.fn().mockResolvedValue([{ affectedRows: 1 }, []]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);
    await repo.setReadiness({
      sessionId: 3,
      readiness: { ready: true, openQuestions: [], summary: "ok" },
    });
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("UPDATE compose_sessions");
    expect(sql).toContain("readiness_json = CAST(? AS JSON)");
    expect(sql).toContain("status = 'ready'");
    expect(sql).toContain("status <> 'archived'");
  });

  it("setReadiness leaves status when not ready (only updates json)", async () => {
    const query = vi.fn().mockResolvedValue([{ affectedRows: 1 }, []]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);
    await repo.setReadiness({
      sessionId: 3,
      readiness: { ready: false, openQuestions: ["x"], summary: "no" },
    });
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("readiness_json = CAST(? AS JSON)");
    expect(sql).not.toContain("status =");
    expect(sql).toContain("status <> 'archived'");
  });

  it("markSessionContextDirty clears readiness and demotes ready sessions to draft", async () => {
    const query = vi.fn().mockResolvedValueOnce([{ affectedRows: 1 }, []]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);

    await repo.markSessionContextDirty(3);

    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("readiness_json = NULL");
    expect(sql).toContain("claude_session_id = NULL");
    expect(sql).toContain(
      "status = CASE WHEN status = 'ready' THEN 'draft' ELSE status END",
    );
    expect(sql).toContain("status <> 'archived'");
    expect(query.mock.calls[0][1]).toEqual([3]);
  });

  it("resetSessionProgress deletes durable turn rows, messages, and derived state in one transaction", async () => {
    const connection = transactionalConnection();
    connection.query.mockResolvedValue([{ affectedRows: 1 }, []]);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await repo.resetSessionProgress(7);

    expect(connection.beginTransaction).toHaveBeenCalledOnce();
    const sql = connection.query.mock.calls.map((call) => String(call[0]));
    const findSql = (fragment: string) =>
      sql.find((statement) => statement.includes(fragment)) ?? "";
    expect(findSql("DELETE FROM compose_turn_outputs")).toBeTruthy();
    expect(findSql("UPDATE compose_context_patches")).toContain(
      "status = 'superseded'",
    );
    expect(findSql("UPDATE compose_handoffs")).toContain(
      "build_agent_task_id = NULL",
    );
    expect(findSql("UPDATE compose_agent_tasks")).toContain(
      "output_source_id = NULL",
    );
    expect(findSql("DELETE deletion")).toContain(
      "FROM compose_source_deletions deletion",
    );
    expect(findSql("DELETE deletion")).toContain(
      "source.source_origin = 'agent'",
    );
    expect(findSql("DELETE chunks")).toContain("source_origin = 'agent'");
    expect(findSql("DELETE revisions")).toContain("source_origin = 'agent'");
    expect(findSql("DELETE FROM compose_session_sources")).toContain(
      "source_origin = 'agent'",
    );
    expect(findSql("DELETE FROM compose_agent_runtime_runs")).toBeTruthy();
    expect(findSql("DELETE FROM compose_agent_tasks")).toBeTruthy();
    expect(findSql("DELETE FROM compose_turn_jobs")).toBeTruthy();
    expect(findSql("DELETE FROM compose_session_messages")).toBeTruthy();
    expect(findSql("DELETE FROM compose_workspace_manifests")).toBeTruthy();
    const updateSql = findSql("UPDATE compose_sessions");
    expect(updateSql).toContain("readiness_json = NULL");
    expect(updateSql).toContain("claude_session_id = NULL");
    expect(updateSql).toContain("status <> 'archived'");
    expect(
      connection.query.mock.calls.every(
        (call) => (call[1] as unknown[])[0] === 7,
      ),
    ).toBe(true);
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledOnce();
  });

  it("getHardDeletePlan inventories archived-session rows and artifact roots", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([
        [
          {
            id: 7,
            status: "archived",
            source_id: 55,
            s3_prefix: "compose/7/",
            workspace_path: "/workspaces/compose/7",
            archived_at: "2026-07-01T00:00:00.000Z",
          },
        ],
        [],
      ])
      .mockResolvedValueOnce([
        [
          {
            compose_session_events: 4,
            compose_stream_tokens: 1,
            compose_turn_jobs: 2,
            compose_turn_outputs: 1,
            compose_agent_tasks: 3,
            compose_agent_runtime_runs: 4,
            compose_context_patches: 2,
            compose_context_versions: 1,
            compose_session_messages: 6,
            compose_session_sources: 5,
            compose_source_deletions: 1,
            compose_workspace_manifests: 1,
            spec_factory_llm_calls: 2,
            compose_sessions: 1,
          },
        ],
        [],
      ])
      .mockResolvedValueOnce([
        [
          { artifact_uri: "s3://bucket/compose/7/generated/research.md" },
          { artifact_uri: "compose/7/raw/10-input.pdf" },
          { artifact_uri: "file:///workspaces/compose/7/context/v1.md" },
          { artifact_uri: "s3://bucket/compose/7/generated/research.md" },
        ],
        [],
      ]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);

    const plan = await repo.getHardDeletePlan(7);

    expect(plan).toMatchObject({
      sessionId: 7,
      status: "archived",
      linkedSourceId: 55,
      s3Prefix: "compose/7/",
      workspacePath: "/workspaces/compose/7",
      rowCounts: {
        compose_turn_jobs: 2,
        compose_agent_runtime_runs: 4,
        compose_session_sources: 5,
        compose_source_deletions: 1,
        compose_workspace_manifests: 1,
        spec_factory_llm_calls: 2,
      },
      artifactUris: [
        "s3://bucket/compose/7/generated/research.md",
        "compose/7/raw/10-input.pdf",
        "file:///workspaces/compose/7/context/v1.md",
      ],
    });
  });

  it("hardDeleteArchivedSession cascades compose rows in FK-safe order", async () => {
    const connection = transactionalConnection();
    connection.query
      .mockResolvedValueOnce([
        [
          {
            id: 7,
            status: "archived",
            s3_prefix: "compose/7/",
            workspace_path: "/workspaces/compose/7",
          },
        ],
        [],
      ])
      .mockResolvedValue([{ affectedRows: 1 }, []]);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await repo.hardDeleteArchivedSession(7);

    expect(connection.beginTransaction).toHaveBeenCalledOnce();
    const sql = connection.query.mock.calls.map((call) => String(call[0]));
    expect(sql[0]).toContain("FOR UPDATE");
    const indexOf = (fragment: string) =>
      sql.findIndex((statement) => statement.includes(fragment));
    expect(indexOf("DELETE receipt")).toBeGreaterThan(0);
    expect(indexOf("DELETE FROM spec_factory_outbox")).toBeGreaterThan(0);
    expect(indexOf("DELETE FROM compose_handoff_snapshots")).toBeGreaterThan(0);
    expect(indexOf("DELETE FROM compose_handoffs")).toBeGreaterThan(0);
    expect(indexOf("DELETE FROM compose_session_events")).toBeGreaterThan(0);
    expect(indexOf("DELETE FROM spec_factory_llm_calls")).toBeGreaterThan(0);
    expect(indexOf("DELETE FROM compose_workspace_manifests")).toBeGreaterThan(
      0,
    );
    expect(indexOf("DELETE FROM compose_stream_tokens")).toBeGreaterThan(0);
    expect(indexOf("DELETE FROM compose_turn_outputs")).toBeGreaterThan(0);
    expect(indexOf("DELETE FROM compose_context_versions")).toBeGreaterThan(0);
    expect(indexOf("DELETE FROM compose_context_patches")).toBeGreaterThan(0);
    expect(indexOf("DELETE FROM compose_agent_runtime_runs")).toBeGreaterThan(
      0,
    );
    expect(indexOf("UPDATE compose_agent_tasks")).toBeGreaterThan(0);
    expect(sql[indexOf("UPDATE compose_agent_tasks")]).toContain(
      "output_source_id = NULL",
    );
    expect(indexOf("DELETE FROM compose_source_chunks")).toBeLessThan(
      indexOf("DELETE FROM compose_source_revisions"),
    );
    expect(indexOf("DELETE FROM compose_source_revisions")).toBeLessThan(
      indexOf("DELETE FROM compose_source_deletions"),
    );
    expect(indexOf("DELETE FROM compose_source_deletions")).toBeLessThan(
      indexOf("DELETE FROM compose_session_sources"),
    );
    expect(indexOf("DELETE FROM compose_session_sources")).toBeLessThan(
      indexOf("DELETE FROM compose_agent_tasks"),
    );
    expect(indexOf("DELETE FROM compose_agent_tasks")).toBeLessThan(
      indexOf("DELETE FROM compose_turn_jobs"),
    );
    expect(indexOf("DELETE FROM compose_turn_jobs")).toBeLessThan(
      indexOf("DELETE FROM compose_session_messages"),
    );
    expect(indexOf("DELETE FROM compose_session_messages")).toBeLessThan(
      indexOf("DELETE FROM compose_sessions"),
    );
    expect(
      connection.query.mock.calls[indexOf("DELETE FROM compose_sessions")][1],
    ).toEqual([7]);
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledOnce();
  });

  it("hardDeleteArchivedSession rejects non-archived sessions before deleting children", async () => {
    const connection = transactionalConnection();
    connection.query.mockResolvedValueOnce([
      [
        {
          id: 7,
          status: "draft",
          s3_prefix: "compose/7/",
          workspace_path: "/workspaces/compose/7",
        },
      ],
      [],
    ]);
    const repo = new ComposeRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValueOnce(connection),
    } as never);

    await expect(repo.hardDeleteArchivedSession(7)).rejects.toThrow(
      "compose_hard_delete_requires_archived_session",
    );

    expect(connection.query).toHaveBeenCalledTimes(1);
    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(connection.release).toHaveBeenCalledOnce();
  });

  it("listComposeS3Prefixes returns distinct session prefixes under the root prefix", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([
        [
          { s3_prefix: "compose/7/" },
          { s3_prefix: "compose/8/" },
          { s3_prefix: "compose/7/" },
        ],
        [],
      ]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);

    const prefixes = await repo.listComposeS3Prefixes({
      rootPrefix: "compose/",
      limit: 500,
    });

    expect(prefixes).toEqual(["compose/7/", "compose/8/"]);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("FROM compose_sessions");
    expect(sql).toContain("s3_prefix LIKE ?");
    expect(sql).toContain("ORDER BY s3_prefix ASC");
    expect(query.mock.calls[0][1]).toEqual(["compose/%", 500]);
  });
});
