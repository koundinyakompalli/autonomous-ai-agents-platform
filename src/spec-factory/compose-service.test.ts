import { createHash } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ComposeService,
  enrichCoordinatorReadiness,
} from "./compose-service.js";

beforeAll(() => {
  // Keep retry backoff effectively instant in tests so we don't hit timeouts.
  process.env.COMPOSE_RETRY_BASE_MS = "1";
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function sessionSummary(overrides = {}) {
  return {
    id: 7,
    name: "Billing export",
    createdBy: null,
    createdByDisplay: null,
    status: "draft",
    claudeSessionId: null,
    sourceId: null,
    readiness: null,
    s3Prefix: "compose/7/",
    workspacePath: "/mnt/efs/spec-factory/compose/7",
    sourceCount: 1,
    passwordProtected: false,
    createdAt: "2026-06-02T00:00:00.000Z",
    updatedAt: "2026-06-02T00:00:00.000Z",
    ...overrides,
  };
}

function contextProjection(overrides = {}) {
  return {
    sessionId: 7,
    version: 4,
    artifactUri: "s3://bucket/compose/7/context/working-context-v4.md",
    structuredArtifactUri:
      "s3://bucket/compose/7/context/working-context-v4.json",
    summary: {
      objective: "Build invoice export",
      problemStatement: "Users need exports for billing audits.",
      recommendedNextActions: ["Inspect billing-service export flow"],
    },
    facts: [],
    openQuestions: [
      {
        id: "q1",
        question: "Which date range should exports support?",
        options: ["Last 30 days", "Custom range"],
      },
    ],
    decisions: [],
    sourceIds: [61],
    patchIds: [701],
    committedAt: "2026-07-05T10:30:00.000Z",
    ...overrides,
  };
}

function sourceDeletionSummary(overrides = {}) {
  return {
    id: 801,
    sessionId: 7,
    sourceId: 21,
    sourceTitle: "requirements.md",
    status: "undoable" as const,
    undoUntil: "2026-07-11T12:10:00.000Z",
    invalidatedSourceIds: [21, 22],
    invalidatedHandoffIds: [91],
    dependentSourceCount: 1,
    createdAt: "2026-07-11T12:00:00.000Z",
    ...overrides,
  };
}

function buildService(
  options: {
    chatCoordinator?: { decide: ReturnType<typeof vi.fn> };
    legacyChatExecutor?: { execute: ReturnType<typeof vi.fn> };
    chatCoordinationExecutor?: { execute: ReturnType<typeof vi.fn> };
    metrics?: { recordCoordinatorRoute: ReturnType<typeof vi.fn> };
  } = {},
) {
  const composeRepository = {
    createSession: vi.fn().mockResolvedValue(7),
    updateSessionPaths: vi.fn().mockResolvedValue(undefined),
    recordSessionActivity: vi.fn().mockResolvedValue(undefined),
    getSession: vi.fn().mockResolvedValue(sessionSummary()),
    getLatestContextProjection: vi.fn().mockResolvedValue(null),
    getContextProjection: vi.fn().mockResolvedValue(contextProjection()),
    getSessionPasswordHash: vi.fn().mockResolvedValue(null),
    listSessions: vi.fn().mockResolvedValue([]),
    archiveSession: vi.fn().mockResolvedValue(true),
    archiveSessionWithWorkCancellation: vi.fn().mockResolvedValue({
      archived: true,
      cancelledTurnJobIds: [],
      cancelledAgentTaskIds: [],
    }),
    cancelTurnJob: vi.fn().mockResolvedValue({
      cancelled: true,
      cancelledAgentTaskIds: [501],
      status: "cancelled",
    }),
    addNoteSource: vi.fn().mockResolvedValue(12),
    createJiraSource: vi.fn().mockResolvedValue(13),
    createConfluenceSource: vi.fn().mockResolvedValue(14),
    restoreConvertedSource: vi.fn().mockResolvedValue(15),
    deleteSessionSource: vi.fn().mockResolvedValue(sourceDeletionSummary()),
    listUndoableSourceDeletions: vi
      .fn()
      .mockResolvedValue([sourceDeletionSummary()]),
    restoreSessionSource: vi
      .fn()
      .mockResolvedValue(sourceDeletionSummary({ status: "restored" })),
    markSessionContextDirty: vi.fn().mockResolvedValue(undefined),
    linkSource: vi.fn().mockResolvedValue(undefined),
    createUploadSource: vi.fn(),
    createYoutubeSource: vi.fn(),
    updateSourceS3Key: vi.fn().mockResolvedValue(undefined),
    getSessionSource: vi.fn(),
    listSessionSources: vi.fn().mockResolvedValue([]),
    listSessionSourceContents: vi.fn().mockResolvedValue([]),
    reconvertSource: vi.fn().mockResolvedValue(undefined),
    reconvertFailedSessionSources: vi.fn().mockResolvedValue(0),
    markSourceUploaded: vi.fn().mockResolvedValue(undefined),
    completeSourceConversion: vi.fn().mockResolvedValue({
      distillationAgentTaskId: null,
      sourceRevisionId: 91,
      chunkCount: 1,
    }),
    appendMessage: vi.fn().mockResolvedValue(1),
    appendAssistantMessageIfSessionActive: vi.fn().mockResolvedValue({
      assistantMessageId: 52,
      deduplicated: false,
    }),
    listMessages: vi.fn().mockResolvedValue([]),
    setClaudeSessionId: vi.fn().mockResolvedValue(undefined),
    setReadiness: vi.fn().mockResolvedValue(undefined),
    resetSessionProgress: vi.fn().mockResolvedValue(undefined),
    createMessageTurn: vi.fn().mockResolvedValue({
      turnJobId: 101,
      messageId: 51,
      status: "queued",
      deduplicated: false,
    }),
    createAnalyzeTurn: vi.fn().mockResolvedValue({
      turnJobId: 102,
      messageId: null,
      status: "queued",
      deduplicated: false,
    }),
    createAgentTask: vi.fn().mockResolvedValue(501),
    createHandoffBuildTask: vi.fn().mockResolvedValue({
      handoffId: 701,
      agentTaskId: 501,
      requestedContextVersion: 4,
      messageHighWatermarkId: 99,
      deduplicated: false,
    }),
    listTurnAgentTasks: vi.fn().mockResolvedValue([]),
    getSessionResearchBudgetUsage: vi.fn().mockResolvedValue({
      spentCostUsd: 0,
      reservedCostUsd: 0,
      researchTasks24h: 0,
      inFlightTasks: 0,
    }),
    getGlobalResearchBudgetUsage: vi.fn().mockResolvedValue({
      spentCostUsd: 0,
      reservedCostUsd: 0,
      researchTasks24h: 0,
      inFlightTasks: 0,
    }),
    parkTurnForResearch: vi.fn().mockResolvedValue({
      parked: true,
      agentTaskIds: [501],
    }),
    parkTurnForClarification: vi.fn().mockResolvedValue({
      parked: true,
      assistantMessageId: 52,
    }),
    answerAwaitingClarification: vi.fn().mockResolvedValue(null),
    appendSessionEvent: vi.fn().mockResolvedValue({ id: 901 }),
    markTurnJobRunning: vi.fn().mockResolvedValue({ leaseGeneration: 1 }),
    renewTurnLease: vi.fn().mockResolvedValue(true),
    confirmTurnLease: vi.fn().mockResolvedValue(true),
    markTurnJobFailed: vi.fn().mockResolvedValue(true),
    completeTurnWithAssistantMessage: vi.fn().mockResolvedValue({
      assistantMessageId: 52,
      deduplicated: false,
    }),
    createStreamToken: vi.fn().mockResolvedValue(undefined),
    verifyStreamTokenHash: vi.fn().mockResolvedValue(false),
    revokeSessionStreamTokens: vi.fn().mockResolvedValue(0),
  };
  const specRepository = {
    createComposeSource: vi.fn().mockResolvedValue(88),
    createEvidenceSnapshot: vi.fn().mockResolvedValue(501),
  };
  const draftRequester = {
    requestDraftGeneration: vi.fn().mockResolvedValue({ queued: true }),
  };
  const uploads = {
    createUploadUrl: vi.fn(),
    createPreviewUrl: vi.fn(),
  };
  const conversionWorker = {
    drain: vi.fn().mockResolvedValue(undefined),
  };
  const chatAgent = {
    run: vi.fn(),
  };
  const workspaceManager = {
    prepare: vi.fn().mockResolvedValue("compose_repo"),
    writeArtifact: vi.fn(async ({ relativePath, content }) => ({
      artifactUri: `file:///mnt/efs/spec-factory/compose/7/${relativePath}`,
      relativePath,
      bytes: Buffer.byteLength(
        Buffer.isBuffer(content) ? content : String(content),
      ),
      sha256: createHash("sha256").update(content).digest("hex"),
    })),
  };
  const sseHub = {
    publish: vi.fn(),
  };
  const jiraSourceFetcher = {
    fetchMarkdown: vi.fn().mockResolvedValue({
      issueKey: "CPDEV-123",
      title: "CPDEV-123 Add export",
      sourceUrl: "https://jira.example.com/browse/CPDEV-123",
      markdownContent: "# CPDEV-123 Add export\n\nBuild CSV export.",
    }),
  };
  const lookupRepositories = vi.fn().mockResolvedValue([
    {
      id: 3,
      repo_name: "medhok-monorepo",
      repo_url: "https://github.com/mhk-repos/cp-medhok-monorepo.git",
      description: "Core app",
      default_branch: "master",
      created_at: new Date("2026-06-01T00:00:00.000Z"),
    },
    {
      id: 5,
      repo_name: "cp-autonomous-ai-agents-platform",
      repo_url:
        "https://github.com/mhk-repos/cp-autonomous-ai-agents-platform.git",
      description: "Agent platform",
      default_branch: "main",
      created_at: new Date("2026-06-01T00:00:00.000Z"),
    },
  ]);
  const repoGrounding = {
    groundRepos: vi.fn().mockResolvedValue({
      codeRepoIds: [],
      repositoriesMarkdown: "",
      manifest: [],
    }),
  };
  const service = new ComposeService(
    composeRepository as never,
    specRepository as never,
    draftRequester as never,
    uploads as never,
    conversionWorker as never,
    chatAgent as never,
    workspaceManager as never,
    sseHub as never,
    { workspaceBase: "/mnt/efs/spec-factory/compose", s3Prefix: "compose" },
    {
      jiraSourceFetcher: jiraSourceFetcher as never,
      lookupRepositories,
      repoGrounding,
      chatCoordinator: options.chatCoordinator as never,
      legacyChatExecutor: options.legacyChatExecutor as never,
      chatCoordinationExecutor: options.chatCoordinationExecutor as never,
      metrics: options.metrics as never,
    },
  );
  return {
    service,
    composeRepository,
    specRepository,
    draftRequester,
    uploads,
    conversionWorker,
    chatAgent,
    workspaceManager,
    sseHub,
    jiraSourceFetcher,
    lookupRepositories,
    repoGrounding,
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushAsyncTurns(times = 8) {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function flushMicrotasks(times = 8) {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

async function withDurableTurnsMode<T>(
  mode: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = process.env.SPEC_FACTORY_DURABLE_TURNS;
  process.env.SPEC_FACTORY_DURABLE_TURNS = mode;
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.SPEC_FACTORY_DURABLE_TURNS;
    } else {
      process.env.SPEC_FACTORY_DURABLE_TURNS = previous;
    }
  }
}

describe("ComposeService", () => {
  it("fills missing coordinator metadata without replacing authoritative session values", () => {
    expect(
      enrichCoordinatorReadiness(
        {
          ready: false,
          openQuestions: [],
          summary: "",
          details: {
            module: "Existing module",
            difficulty: "L",
            loeHours: 40,
            storyPoints: 13,
            repositories: ["existing-repo"],
          },
        },
        {
          attachedSources: [
            {
              id: 206,
              title: "CPSR-1100",
              kind: "jira",
              summary: "P32Health request",
              markdown: "# CPSR-1100",
              entities: {
                repositories: ["source-repo"],
                loeHours: [60],
              },
            },
          ],
        } as never,
        {
          module: "Suggested module",
          repositories: ["suggested-repo"],
          difficulty: "M",
          loeHours: 80,
          storyPoints: 8,
        },
      ),
    ).toEqual({
      ready: false,
      openQuestions: [],
      summary: "",
      details: {
        module: "Existing module",
        difficulty: "L",
        loeHours: 40,
        storyPoints: 13,
        repositories: ["existing-repo", "source-repo", "suggested-repo"],
      },
    });
  });

  it("getContextProjection returns the latest committed context after the read guard", async () => {
    const { service, composeRepository } = buildService();
    const projection = contextProjection({ openQuestions: [] });
    composeRepository.getLatestContextProjection.mockResolvedValueOnce(
      projection,
    );

    await expect(service.getContextProjection(7)).resolves.toEqual(projection);

    expect(composeRepository.getSession).toHaveBeenCalledWith(7);
    expect(composeRepository.getLatestContextProjection).toHaveBeenCalledWith(
      7,
    );
  });

  it("hydrates historical context summaries from session readiness", async () => {
    const { service, composeRepository } = buildService();
    composeRepository.getSession.mockResolvedValueOnce(
      sessionSummary({
        readiness: {
          ready: false,
          openQuestions: [],
          summary: "Make billing reviews self-service.",
          problem: "Auditors cannot obtain billing records without support.",
          ideating: "Provide a governed self-service export.",
          businessRequirements: ["Reduce manual audit support."],
          functionalRequirements: ["Auditors can request an export."],
          challenges: ["Exports contain sensitive data."],
          stories: [
            {
              id: "story-1",
              title: "Request an export",
              summary: "Auditors request billing records.",
            },
          ],
          nextStep: "Confirm export retention policy.",
        },
      }),
    );
    composeRepository.getLatestContextProjection.mockResolvedValueOnce(
      contextProjection({ summary: null }),
    );

    const projection = await service.getContextProjection(7);

    expect(projection?.summary).toEqual({
      objective: "Make billing reviews self-service.",
      problemStatement:
        "Auditors cannot obtain billing records without support.",
      solution: "Provide a governed self-service export.",
      businessRequirements: ["Reduce manual audit support."],
      functionalRequirements: ["Auditors can request an export."],
      challenges: ["Exports contain sensitive data."],
      stories: [
        {
          id: "story-1",
          title: "Request an export",
          summary: "Auditors request billing records.",
        },
      ],
      recommendedNextActions: ["Confirm export retention policy."],
    });
  });

  it("keeps committed context fields authoritative over readiness fallbacks", async () => {
    const { service, composeRepository } = buildService();
    composeRepository.getSession.mockResolvedValueOnce(
      sessionSummary({
        readiness: {
          ready: true,
          openQuestions: [],
          summary: "Stale readiness objective",
          problem: "Stale readiness problem",
          solution: "Stale readiness solution",
        },
      }),
    );
    composeRepository.getLatestContextProjection.mockResolvedValueOnce(
      contextProjection({
        summary: {
          objective: "Committed objective",
          problemStatement: "Committed problem",
          solution: "Committed solution",
          businessRequirements: [],
          functionalRequirements: [],
          challenges: [],
          stories: [],
          recommendedNextActions: [],
        },
      }),
    );

    const projection = await service.getContextProjection(7);

    expect(projection?.summary).toMatchObject({
      objective: "Committed objective",
      problemStatement: "Committed problem",
      solution: "Committed solution",
    });
  });

  it("getSession projects readiness from committed context when legacy readiness is empty", async () => {
    const { service, composeRepository } = buildService();
    composeRepository.getLatestContextProjection.mockResolvedValueOnce(
      contextProjection(),
    );

    const session = await service.getSession(7);

    expect(session.readiness).toMatchObject({
      ready: false,
      summary: "Build invoice export",
      problem: "Users need exports for billing audits.",
      openQuestions: ["Which date range should exports support?"],
      nextStep: "Inspect billing-service export flow",
      questions: [
        {
          id: "q1",
          question: "Which date range should exports support?",
          options: ["Last 30 days", "Custom range"],
        },
      ],
    });
    expect(session.readiness?.validatorWarnings).toContainEqual({
      code: "context_projection",
      message: "Readiness was projected from Working Context version 4.",
      severity: "info",
    });
  });

  it("getSession hides owned sessions from non-owners", async () => {
    const { service, composeRepository } = buildService();
    composeRepository.getSession.mockResolvedValue(
      sessionSummary({ createdBy: "owner@example.com" }),
    );

    await expect(service.getSession(7, "owner@example.com")).resolves.toEqual(
      expect.objectContaining({ id: 7 }),
    );
    await expect(service.getSession(7, "other@example.com")).rejects.toThrow(
      /not found/i,
    );
  });

  it("listSessions projects readiness for sessions missing legacy readiness without overwriting stored readiness", async () => {
    const { service, composeRepository } = buildService();
    composeRepository.listSessions.mockResolvedValueOnce([
      sessionSummary({ id: 7, readiness: null }),
      sessionSummary({
        id: 8,
        readiness: {
          ready: true,
          openQuestions: [],
          summary: "Stored readiness wins",
        },
      }),
    ]);
    composeRepository.getLatestContextProjection.mockResolvedValueOnce(
      contextProjection({ sessionId: 7 }),
    );

    const sessions = await service.listSessions();

    expect(sessions[0].readiness?.summary).toBe("Build invoice export");
    expect(sessions[1].readiness?.summary).toBe("Stored readiness wins");
    expect(composeRepository.getLatestContextProjection).toHaveBeenCalledTimes(
      1,
    );
    expect(composeRepository.getLatestContextProjection).toHaveBeenCalledWith(
      7,
    );
  });

  it("createSession computes and persists workspace + s3 paths from the new id", async () => {
    const { service, composeRepository } = buildService();
    const session = await service.createSession({
      name: "Billing export",
      createdBy: "kompallik",
      createdByDisplay: "Koundinya",
    });
    expect(session.id).toBe(7);
    expect(composeRepository.updateSessionPaths).toHaveBeenCalledWith({
      sessionId: 7,
      s3Prefix: "compose/7/",
      workspacePath: "/mnt/efs/spec-factory/compose/7",
    });
    expect(
      composeRepository.createSession.mock.calls[0][0].passwordHash,
    ).toBeNull();
    expect(composeRepository.appendSessionEvent).toHaveBeenCalledWith({
      sessionId: 7,
      eventType: "session.created",
      payload: {
        name: "Billing export",
        createdByDisplay: "Koundinya",
        s3Prefix: "compose/7/",
        workspacePath: "/mnt/efs/spec-factory/compose/7",
        passwordProtected: false,
      },
      actorType: "user",
      actorId: "kompallik",
    });
  });

  it("createSession hashes an optional password before persistence", async () => {
    const { service, composeRepository } = buildService();

    await service.createSession({
      name: "Billing export",
      createdBy: null,
      createdByDisplay: null,
      password: "secret",
    });

    const passwordHash =
      composeRepository.createSession.mock.calls[0][0].passwordHash;
    expect(passwordHash).toMatch(/^scrypt:v1:/);
    expect(passwordHash).not.toContain("secret");
  });

  it("createSession rejects a blank name", async () => {
    const { service } = buildService();
    await expect(
      service.createSession({
        name: "  ",
        createdBy: null,
        createdByDisplay: null,
      }),
    ).rejects.toThrow(/name/i);
  });

  it("resumeSession rejects direct access to a protected session without the password", async () => {
    const { service, composeRepository } = buildService();
    composeRepository.getSession.mockResolvedValue(
      sessionSummary({ passwordProtected: true }),
    );

    await expect(service.getSession(7)).rejects.toThrow(
      /Password is required/i,
    );
  });

  it("resumeSession authorizes protected sessions with the matching password", async () => {
    const { service, composeRepository } = buildService();
    await service.createSession({
      name: "Billing export",
      createdBy: null,
      createdByDisplay: null,
      password: "secret",
    });
    const passwordHash =
      composeRepository.createSession.mock.calls[0][0].passwordHash;
    composeRepository.getSession.mockResolvedValue(
      sessionSummary({ passwordProtected: true }),
    );
    composeRepository.getSessionPasswordHash.mockResolvedValue(passwordHash);

    await expect(
      service.resumeSession({ sessionId: 7, password: "secret" }),
    ).resolves.toMatchObject({ id: 7 });
    await expect(
      service.resumeSession({ sessionId: 7, password: "wrong" }),
    ).rejects.toThrow(/Invalid password/i);
  });

  it("deleteSession archives unprotected sessions without a password", async () => {
    const { service, composeRepository, sseHub } = buildService();

    await service.deleteSession({ sessionId: 7 });

    expect(
      composeRepository.archiveSessionWithWorkCancellation,
    ).toHaveBeenCalledWith(7);
    expect(composeRepository.archiveSession).not.toHaveBeenCalled();
    expect(sseHub.publish).toHaveBeenCalledWith(7, {
      type: "session",
      status: "archived",
    });
  });

  it("deleteSession records durable cancellation events for active session work", async () => {
    const { service, composeRepository } = buildService();
    composeRepository.archiveSessionWithWorkCancellation.mockResolvedValueOnce({
      archived: true,
      cancelledTurnJobIds: [101, 102],
      cancelledAgentTaskIds: [501],
    });

    await service.deleteSession({ sessionId: 7, actor: "kompallik" });

    expect(composeRepository.appendSessionEvent).toHaveBeenCalledWith({
      sessionId: 7,
      eventType: "turn.cancelled",
      payload: {
        type: "turn",
        status: "cancelled",
        reason: "session_archived",
        turnJobId: 101,
      },
      actorType: "user",
      actorId: "kompallik",
      turnJobId: 101,
    });
    expect(composeRepository.appendSessionEvent).toHaveBeenCalledWith({
      sessionId: 7,
      eventType: "turn.cancelled",
      payload: {
        type: "turn",
        status: "cancelled",
        reason: "session_archived",
        turnJobId: 102,
      },
      actorType: "user",
      actorId: "kompallik",
      turnJobId: 102,
    });
    expect(composeRepository.appendSessionEvent).toHaveBeenCalledWith({
      sessionId: 7,
      eventType: "task.cancelled",
      payload: {
        type: "task",
        status: "cancelled",
        reason: "session_archived",
        agentTaskId: 501,
      },
      actorType: "user",
      actorId: "kompallik",
      agentTaskId: 501,
    });
  });

  it("cancelTurn cancels a durable turn and records cancellation events", async () => {
    const { service, composeRepository } = buildService();

    await expect(
      service.cancelTurn({
        sessionId: 7,
        turnJobId: 101,
        actor: "kompallik",
      }),
    ).resolves.toEqual({
      cancelled: true,
      turnJobId: 101,
      cancelledAgentTaskIds: [501],
      status: "cancelled",
    });

    expect(composeRepository.cancelTurnJob).toHaveBeenCalledWith({
      sessionId: 7,
      turnJobId: 101,
    });
    expect(composeRepository.appendSessionEvent).toHaveBeenCalledWith({
      sessionId: 7,
      eventType: "turn.cancelling",
      payload: {
        type: "turn",
        status: "cancelling",
        reason: "operator_cancelled",
        turnJobId: 101,
      },
      actorType: "user",
      actorId: "kompallik",
      turnJobId: 101,
    });
    expect(composeRepository.appendSessionEvent).toHaveBeenCalledWith({
      sessionId: 7,
      eventType: "turn.cancelled",
      payload: {
        type: "turn",
        status: "cancelled",
        reason: "operator_cancelled",
        turnJobId: 101,
      },
      actorType: "user",
      actorId: "kompallik",
      turnJobId: 101,
    });
    expect(composeRepository.appendSessionEvent).toHaveBeenCalledWith({
      sessionId: 7,
      eventType: "task.cancelled",
      payload: {
        type: "task",
        status: "cancelled",
        reason: "operator_cancelled",
        agentTaskId: 501,
      },
      actorType: "user",
      actorId: "kompallik",
      agentTaskId: 501,
    });
  });

  it("deleteSession rejects non-owner actors before archiving", async () => {
    const { service, composeRepository } = buildService();
    composeRepository.getSession.mockResolvedValue(
      sessionSummary({ createdBy: "owner@example.com" }),
    );

    await expect(
      service.deleteSession({
        sessionId: 7,
        actor: "other@example.com",
      }),
    ).rejects.toThrow(/not found/i);

    expect(
      composeRepository.archiveSessionWithWorkCancellation,
    ).not.toHaveBeenCalled();
  });

  it("deleteSession requires the matching password for protected sessions", async () => {
    const { service, composeRepository } = buildService();
    await service.createSession({
      name: "Billing export",
      createdBy: null,
      createdByDisplay: null,
      password: "secret",
    });
    const passwordHash =
      composeRepository.createSession.mock.calls[0][0].passwordHash;
    composeRepository.getSession.mockResolvedValue(
      sessionSummary({ passwordProtected: true }),
    );
    composeRepository.getSessionPasswordHash.mockResolvedValue(passwordHash);

    await expect(service.deleteSession({ sessionId: 7 })).rejects.toThrow(
      /Password is required/i,
    );
    await expect(
      service.deleteSession({ sessionId: 7, password: "secret" }),
    ).resolves.toBeUndefined();
    expect(
      composeRepository.archiveSessionWithWorkCancellation,
    ).toHaveBeenCalledWith(7);
  });

  it("exportSession returns a portable bundle of converted sources and chat", async () => {
    const { service, composeRepository } = buildService();
    composeRepository.listSessionSources.mockResolvedValueOnce([
      {
        id: 21,
        sessionId: 7,
        kind: "file",
        originalFilename: "requirements.docx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        sizeBytes: 2048,
        sourceUrl: null,
        markdownContent: " Build CSV export. ",
        conversionStatus: "converted",
      },
      {
        id: 22,
        sessionId: 7,
        kind: "youtube",
        originalFilename: "https://youtu.be/x",
        mimeType: null,
        sizeBytes: null,
        sourceUrl: "https://youtu.be/x",
        markdownContent: null,
        conversionStatus: "pending",
      },
    ]);
    composeRepository.listMessages.mockResolvedValueOnce([
      {
        id: 1,
        sessionId: 7,
        role: "user",
        content: " billing-service ",
        createdAt: "t",
      },
    ]);

    const bundle = await service.exportSession({ sessionId: 7 });

    expect(bundle.format).toBe("spec-factory.compose-session");
    expect(bundle.version).toBe(1);
    expect(bundle.session.name).toBe("Billing export");
    expect(bundle.sources).toEqual([
      expect.objectContaining({
        kind: "file",
        originalFilename: "requirements.docx",
        markdownContent: "Build CSV export.",
      }),
    ]);
    expect(bundle.messages).toEqual([
      { role: "user", content: "billing-service" },
    ]);
  });

  it("importSession restores sources, messages, readiness, and prepares the workspace", async () => {
    const { service, composeRepository, workspaceManager } = buildService();
    composeRepository.listSessionSourceContents.mockResolvedValueOnce([
      {
        sourceId: 15,
        filename: "requirements.docx",
        content: "Build CSV export.",
      },
    ]);
    composeRepository.listMessages.mockResolvedValueOnce([
      {
        id: 1,
        sessionId: 7,
        role: "assistant",
        content: "Ready.",
        createdAt: "t",
      },
    ]);

    const result = await service.importSession({
      createdBy: "kompallik",
      createdByDisplay: "Koundinya",
      bundle: {
        format: "spec-factory.compose-session",
        version: 1,
        exportedAt: "2026-06-02T00:00:00.000Z",
        session: {
          name: "Imported plan",
          createdByDisplay: "Original author",
          readiness: {
            ready: true,
            openQuestions: [],
            summary: "Ready to hand off.",
          },
        },
        sources: [
          {
            kind: "file",
            originalFilename: "requirements.docx",
            mimeType:
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            sizeBytes: 2048,
            sourceUrl: null,
            markdownContent: "Build CSV export.",
          },
        ],
        messages: [{ role: "assistant", content: "Ready." }],
      },
    });

    expect(composeRepository.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Imported plan",
        createdBy: "kompallik",
        createdByDisplay: "Koundinya",
      }),
    );
    expect(composeRepository.restoreConvertedSource).toHaveBeenCalledWith({
      sessionId: 7,
      kind: "file",
      originalFilename: "requirements.docx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sizeBytes: 2048,
      sourceUrl: null,
      markdownContent: "Build CSV export.",
    });
    expect(composeRepository.completeSourceConversion).toHaveBeenCalledWith({
      sourceId: 15,
      markdownPath: null,
      markdownContent: "Build CSV export.",
    });
    expect(composeRepository.appendMessage).toHaveBeenCalledWith({
      sessionId: 7,
      role: "assistant",
      content: "Ready.",
    });
    expect(composeRepository.setReadiness).toHaveBeenCalledWith({
      sessionId: 7,
      readiness: {
        ready: true,
        openQuestions: [],
        summary: "Ready to hand off.",
      },
    });
    expect(
      composeRepository.markSessionContextDirty.mock.invocationCallOrder[0],
    ).toBeLessThan(
      composeRepository.completeSourceConversion.mock.invocationCallOrder[0],
    );
    expect(workspaceManager.prepare).toHaveBeenCalledWith({
      sessionId: 7,
      workspacePath: "/mnt/efs/spec-factory/compose/7",
      sources: [
        {
          sourceId: 15,
          filename: "requirements.docx",
          content: "Build CSV export.",
        },
      ],
      messages: [{ role: "assistant", content: "Ready." }],
    });
    expect(result.importedSources).toBe(1);
    expect(result.importedMessages).toBe(1);
  });

  it("importSession rejects invalid bundle uploads", async () => {
    const { service, composeRepository } = buildService();

    await expect(
      service.importSession({
        createdBy: "kompallik",
        createdByDisplay: "Koundinya",
        bundle: { format: "wrong" },
      }),
    ).rejects.toThrow(/Invalid Compose session bundle/i);

    expect(composeRepository.createSession).not.toHaveBeenCalled();
  });

  it("addNote appends a note source", async () => {
    vi.stubEnv("SPEC_FACTORY_ENABLE_CONTEXT_DISTILLATION", "true");
    const { service, composeRepository } = buildService();
    await service.addNote({
      sessionId: 7,
      content: "Repo is billing-service.",
      actor: "kompallik",
    });
    expect(composeRepository.addNoteSource).toHaveBeenCalled();
    const arg = composeRepository.addNoteSource.mock.calls[0][0];
    expect(arg.sessionId).toBe(7);
    expect(arg.content).toContain("billing-service");
    expect(composeRepository.completeSourceConversion).toHaveBeenCalledWith({
      sourceId: 12,
      markdownPath: null,
      markdownContent: "Repo is billing-service.",
      distillationTask: {
        sessionId: 7,
        capability: "source_distillation",
        executorType: "source_distillation",
        input: { sourceId: 12, baseContextVersion: null },
        priority: 80,
        event: {
          eventType: "task.queued",
          payload: {
            capability: "source_distillation",
            executorType: "source_distillation",
            sourceId: 12,
            baseContextVersion: null,
          },
          actorType: "system",
          actorId: "compose-inline-source",
          contextVersion: null,
        },
      },
    });
    expect(composeRepository.markSessionContextDirty).toHaveBeenCalledWith(7);
    expect(composeRepository.appendSessionEvent).toHaveBeenCalledWith({
      sessionId: 7,
      eventType: "source.added",
      payload: expect.objectContaining({
        sourceId: 12,
        kind: "note",
        filename: "note-2.md",
        conversionStatus: "converted",
      }),
      actorType: "user",
      actorId: "kompallik",
    });
  });

  it("addNote rejects blank content", async () => {
    const { service } = buildService();
    await expect(
      service.addNote({ sessionId: 7, content: "   " }),
    ).rejects.toThrow(/content/i);
  });

  it("addNote rejects archived sessions before writing a source", async () => {
    const { service, composeRepository } = buildService();
    composeRepository.getSession.mockResolvedValue(
      sessionSummary({ status: "archived" }),
    );

    await expect(
      service.addNote({ sessionId: 7, content: "hi" }),
    ).rejects.toThrow(/not found/i);
    expect(composeRepository.addNoteSource).not.toHaveBeenCalled();
  });

  it("handoff mints a compose source and queues draft generation", async () => {
    const { service, composeRepository, specRepository, draftRequester } =
      buildService();
    composeRepository.linkSource.mockResolvedValueOnce(true);
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
    expect(composeRepository.appendSessionEvent).toHaveBeenCalledWith({
      sessionId: 7,
      eventType: "handoff.started",
      payload: {
        sourceJiraKey: "COMPOSE-7",
        existingSourceId: null,
      },
      actorType: "user",
      actorId: "kompallik",
    });
    expect(composeRepository.appendSessionEvent).toHaveBeenCalledWith({
      sessionId: 7,
      eventType: "handoff.completed",
      payload: {
        sourceJiraKey: "COMPOSE-7",
        sourceId: 88,
        reusedExistingSource: false,
        enriched: false,
      },
      actorType: "user",
      actorId: "kompallik",
    });
    expect(result.sourceId).toBe(88);
  });

  it("handoff can enrich the compose source summary from readiness and sources", async () => {
    vi.stubEnv("SPEC_FACTORY_HANDOFF_ENRICHED", "true");
    const { service, composeRepository, specRepository } = buildService();
    composeRepository.getSession.mockResolvedValue(
      sessionSummary({
        latestContextVersion: 4,
        readiness: {
          ready: true,
          summary: "Ready for draft generation.",
          openQuestions: [],
          questions: [
            {
              id: "q1",
              question: "Which export format is required?",
              answered: false,
            },
          ],
        },
      }),
    );
    composeRepository.listSessionSources.mockResolvedValueOnce([
      {
        id: 21,
        sessionId: 7,
        kind: "file",
        originalFilename: "requirements.docx",
        conversionStatus: "converted",
      },
      {
        id: 22,
        sessionId: 7,
        kind: "note",
        originalFilename: "note-1.md",
        conversionStatus: "converted",
      },
      {
        id: 23,
        sessionId: 7,
        kind: "generated_research",
        originalFilename: "research.md",
        sourceSummary: "Code research found the export endpoint.",
        conversionStatus: "converted",
      },
    ]);
    composeRepository.linkSource.mockResolvedValueOnce(true);

    await service.handoff({ sessionId: 7, actor: "kompallik" });

    const sourceSummary =
      specRepository.createComposeSource.mock.calls[0][0].sourceSummary;
    expect(sourceSummary).toContain("Billing export");
    expect(sourceSummary).toContain("ready");
    expect(sourceSummary).toContain("3 sources");
    expect(sourceSummary).toContain("1 research artifact");
    expect(sourceSummary).toContain("context v4");
    expect(sourceSummary).toContain("open: Which export format is required?");
    expect(sourceSummary.length).toBeLessThanOrEqual(255);
  });

  it("handoff persists markdown and json bundle artifacts before queueing draft generation", async () => {
    vi.stubEnv("SPEC_FACTORY_HANDOFF_ENRICHED", "true");
    const {
      service,
      composeRepository,
      specRepository,
      workspaceManager,
      draftRequester,
    } = buildService();
    composeRepository.getSession.mockResolvedValue(
      sessionSummary({
        latestContextVersion: 4,
        readiness: {
          ready: true,
          summary: "Ready for draft generation.",
          openQuestions: ["Confirm CSV vs XLSX."],
        },
      }),
    );
    composeRepository.getLatestContextProjection.mockResolvedValueOnce({
      sessionId: 7,
      version: 4,
      artifactUri: "file:///mnt/efs/spec-factory/compose/7/context/v4.md",
      structuredArtifactUri:
        "file:///mnt/efs/spec-factory/compose/7/context/v4.json",
      summary: {
        objective: "Deliver billing exports.",
        problemStatement: "Operators need an auditable export flow.",
        recommendedNextActions: ["Draft the API contract."],
      },
      facts: ["Billing service owns export generation."],
      openQuestions: ["Confirm CSV vs XLSX."],
      decisions: ["Use the existing export controller."],
      sourceIds: [23],
      patchIds: [701],
      committedAt: "2026-06-08T13:58:00.000Z",
    });
    composeRepository.listSessionSources.mockResolvedValueOnce([
      {
        id: 23,
        sessionId: 7,
        kind: "generated_research",
        originalFilename: "research.md",
        sourceSummary: "Code research found the export endpoint.",
        conversionStatus: "converted",
      },
    ]);
    composeRepository.linkSource.mockResolvedValueOnce(true);

    await service.handoff({ sessionId: 7, actor: "kompallik" });

    expect(composeRepository.getLatestContextProjection).toHaveBeenCalledWith(
      7,
    );
    expect(workspaceManager.writeArtifact).toHaveBeenNthCalledWith(1, {
      workspacePath: "/mnt/efs/spec-factory/compose/7",
      relativePath: "handoff/handoff-v2.md",
      content: expect.stringContaining("## Working Context"),
    });
    expect(workspaceManager.writeArtifact.mock.calls[0][0].content).toContain(
      "Billing service owns export generation.",
    );
    expect(workspaceManager.writeArtifact).toHaveBeenNthCalledWith(2, {
      workspacePath: "/mnt/efs/spec-factory/compose/7",
      relativePath: "handoff/handoff-v2.json",
      content: expect.stringContaining('"schemaVersion": 2'),
    });
    expect(workspaceManager.writeArtifact.mock.calls[1][0].content).toContain(
      '"workingContext"',
    );
    expect(specRepository.createEvidenceSnapshot).toHaveBeenCalledWith({
      sourceId: 88,
      manifest: expect.objectContaining({
        sourceJiraKey: "COMPOSE-7",
        sourceSummary: expect.stringContaining("Billing export"),
        descriptionMarkdown: expect.stringContaining(
          "# Handoff: Billing export",
        ),
        artifacts: [
          expect.objectContaining({
            filename: "handoff-v2.md",
            artifactUri:
              "file:///mnt/efs/spec-factory/compose/7/handoff/handoff-v2.md",
          }),
          expect.objectContaining({
            filename: "handoff-v2.json",
            artifactUri:
              "file:///mnt/efs/spec-factory/compose/7/handoff/handoff-v2.json",
          }),
        ],
      }),
    });
    expect(
      specRepository.createEvidenceSnapshot.mock.invocationCallOrder[0],
    ).toBeLessThan(
      draftRequester.requestDraftGeneration.mock.invocationCallOrder[0],
    );
    expect(composeRepository.appendSessionEvent).toHaveBeenCalledWith({
      sessionId: 7,
      eventType: "handoff.completed",
      payload: expect.objectContaining({
        sourceJiraKey: "COMPOSE-7",
        sourceId: 88,
        reusedExistingSource: false,
        enriched: true,
        artifactBytes: expect.objectContaining({
          markdown: expect.any(Number),
          json: expect.any(Number),
          total: expect.any(Number),
        }),
      }),
      actorType: "user",
      actorId: "kompallik",
    });
  });

  it("handoff queues a handoff_build task when queued handoff is enabled", async () => {
    vi.stubEnv("SPEC_FACTORY_HANDOFF_BUILD_TASK_ENABLED", "true");
    const { service, composeRepository, workspaceManager, draftRequester } =
      buildService();
    composeRepository.getSession.mockResolvedValue(
      sessionSummary({
        latestContextVersion: 4,
        readiness: {
          ready: true,
          summary: "Ready for draft generation.",
          openQuestions: [],
        },
      }),
    );
    composeRepository.listSessionSources.mockResolvedValueOnce([
      {
        id: 23,
        sessionId: 7,
        kind: "file",
        originalFilename: "requirements.md",
        sourceSummary: "Requirements.",
        conversionStatus: "converted",
      },
    ]);
    composeRepository.linkSource.mockResolvedValueOnce(true);

    await service.handoff({
      sessionId: 7,
      actor: "kompallik",
      idempotencyKey: "handoff-session-7",
    });

    expect(composeRepository.createHandoffBuildTask).toHaveBeenCalledWith({
      sessionId: 7,
      sourceId: 88,
      idempotencyKey: "handoff-session-7",
      requestedBy: "kompallik",
      reusedExistingSource: false,
    });
    expect(composeRepository.appendSessionEvent).toHaveBeenCalledWith({
      sessionId: 7,
      eventType: "handoff.snapshot_building",
      payload: {
        handoffId: 701,
        capability: "handoff_build",
        executorType: "handoff_build",
        sourceId: 88,
        contextVersionUsed: 4,
        messageHighWatermarkId: 99,
        deduplicated: false,
      },
      actorType: "user",
      actorId: "kompallik",
      agentTaskId: 501,
      contextVersion: 4,
    });
    expect(composeRepository.appendSessionEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "handoff.completed",
      }),
    );
    expect(workspaceManager.writeArtifact).not.toHaveBeenCalled();
    expect(draftRequester.requestDraftGeneration).not.toHaveBeenCalled();
  });

  it("handoff is idempotent when the session already has a source", async () => {
    const { service, composeRepository, specRepository, draftRequester } =
      buildService();
    composeRepository.getSession.mockResolvedValue(
      sessionSummary({ status: "handed_off", sourceId: 88 }),
    );
    const result = await service.handoff({ sessionId: 7, actor: "kompallik" });
    expect(result.sourceId).toBe(88);
    expect(specRepository.createComposeSource).not.toHaveBeenCalled();
    expect(draftRequester.requestDraftGeneration).toHaveBeenCalledWith({
      sourceId: 88,
      actor: "kompallik",
    });
    expect(composeRepository.appendSessionEvent).toHaveBeenCalledWith({
      sessionId: 7,
      eventType: "handoff.started",
      payload: {
        sourceJiraKey: "COMPOSE-7",
        existingSourceId: 88,
      },
      actorType: "user",
      actorId: "kompallik",
    });
    expect(composeRepository.appendSessionEvent).toHaveBeenCalledWith({
      sessionId: 7,
      eventType: "handoff.completed",
      payload: {
        sourceJiraKey: "COMPOSE-7",
        sourceId: 88,
        reusedExistingSource: true,
        enriched: false,
      },
      actorType: "user",
      actorId: "kompallik",
    });
  });

  it("handoff rejects when sources are incomplete or failed", async () => {
    const { service, composeRepository, specRepository, draftRequester } =
      buildService();
    composeRepository.listSessionSources.mockResolvedValueOnce([
      {
        id: 21,
        sessionId: 7,
        kind: "file",
        originalFilename: "requirements.docx",
        conversionStatus: "failed",
        errorMessage: "bad docx",
      },
    ]);

    await expect(
      service.handoff({ sessionId: 7, actor: "kompallik" }),
    ).rejects.toThrow(
      "Cannot hand off Compose session 7 until blocked sources are resolved: requirements.docx (failed)",
    );

    expect(composeRepository.appendSessionEvent).toHaveBeenCalledWith({
      sessionId: 7,
      eventType: "handoff.failed",
      payload: {
        sourceJiraKey: "COMPOSE-7",
        reason: "blocked_sources",
        message:
          "Cannot hand off Compose session 7 until blocked sources are resolved: requirements.docx (failed)",
      },
      actorType: "user",
      actorId: "kompallik",
    });
    expect(specRepository.createComposeSource).not.toHaveBeenCalled();
    expect(draftRequester.requestDraftGeneration).not.toHaveBeenCalled();
  });

  it("handoff rejects archived sessions before creating a source", async () => {
    const { service, composeRepository, specRepository, draftRequester } =
      buildService();
    composeRepository.getSession.mockResolvedValue(
      sessionSummary({ status: "archived" }),
    );

    await expect(
      service.handoff({ sessionId: 7, actor: "kompallik" }),
    ).rejects.toThrow(/not found/i);
    expect(specRepository.createComposeSource).not.toHaveBeenCalled();
    expect(draftRequester.requestDraftGeneration).not.toHaveBeenCalled();
  });

  it("handoff returns the existing source when another request linked first", async () => {
    const { service, composeRepository, specRepository, draftRequester } =
      buildService();
    composeRepository.getSession
      .mockResolvedValueOnce(sessionSummary({ sourceId: null }))
      .mockResolvedValueOnce(
        sessionSummary({ status: "handed_off", sourceId: 88 }),
      );
    composeRepository.linkSource.mockResolvedValueOnce(false);
    specRepository.createComposeSource.mockResolvedValueOnce(88);

    await expect(
      service.handoff({ sessionId: 7, actor: "kompallik" }),
    ).resolves.toEqual({
      sourceId: 88,
      session: sessionSummary({ status: "handed_off", sourceId: 88 }),
    });

    expect(composeRepository.linkSource).toHaveBeenCalledWith({
      sessionId: 7,
      sourceId: 88,
    });
    expect(draftRequester.requestDraftGeneration).toHaveBeenCalledWith({
      sourceId: 88,
      actor: "kompallik",
    });
  });

  it("handoff recovers an existing synthetic source after duplicate-key creation", async () => {
    const { service, composeRepository, specRepository, draftRequester } =
      buildService();
    const duplicate = Object.assign(
      new Error(
        "Duplicate entry 'COMPOSE-7' for key 'uk_spec_factory_source_key'",
      ),
      { code: "ER_DUP_ENTRY" },
    );
    composeRepository.getSession
      .mockResolvedValueOnce(sessionSummary({ sourceId: null }))
      .mockResolvedValueOnce(
        sessionSummary({ status: "handed_off", sourceId: 88 }),
      );
    composeRepository.linkSource.mockResolvedValueOnce(false);
    specRepository.createComposeSource.mockRejectedValueOnce(duplicate);

    const result = await service.handoff({ sessionId: 7, actor: "kompallik" });

    expect(result.sourceId).toBe(88);
    expect(composeRepository.linkSource).not.toHaveBeenCalled();
    expect(draftRequester.requestDraftGeneration).toHaveBeenCalledWith({
      sourceId: 88,
      actor: "kompallik",
    });
  });

  it("handoff rejects duplicate-key recovery if the refreshed session is archived", async () => {
    const { service, composeRepository, specRepository, draftRequester } =
      buildService();
    const duplicate = Object.assign(
      new Error(
        "Duplicate entry 'COMPOSE-7' for key 'uk_spec_factory_source_key'",
      ),
      { code: "ER_DUP_ENTRY" },
    );
    composeRepository.getSession
      .mockResolvedValueOnce(sessionSummary({ sourceId: null }))
      .mockResolvedValueOnce(
        sessionSummary({ status: "archived", sourceId: 88 }),
      );
    specRepository.createComposeSource.mockRejectedValueOnce(duplicate);

    await expect(
      service.handoff({ sessionId: 7, actor: "kompallik" }),
    ).rejects.toThrow(/not found/i);

    expect(composeRepository.linkSource).not.toHaveBeenCalled();
    expect(draftRequester.requestDraftGeneration).not.toHaveBeenCalled();
  });

  it("requestUpload mints a pending source and returns a presigned target", async () => {
    const { service, composeRepository, uploads } = buildService();
    composeRepository.createUploadSource.mockResolvedValue(21);
    uploads.createUploadUrl.mockResolvedValue({
      sourceId: 21,
      uploadUrl: "https://s3/put",
      s3KeyRaw: "compose/7/raw/21-spec.pdf",
      expiresInSeconds: 900,
    });
    const target = await service.requestUpload({
      sessionId: 7,
      filename: "spec.pdf",
      mimeType: "application/pdf",
      sizeBytes: 2048,
      actor: "kompallik",
    });
    expect(target.uploadUrl).toBe("https://s3/put");
    expect(composeRepository.createUploadSource).toHaveBeenCalledWith(
      expect.objectContaining({ converter: "markitdown" }),
    );
    expect(composeRepository.updateSourceS3Key).toHaveBeenCalledWith({
      sourceId: 21,
      s3KeyRaw: "compose/7/raw/21-spec.pdf",
    });
    expect(composeRepository.markSessionContextDirty).toHaveBeenCalledWith(7);
    expect(composeRepository.appendSessionEvent).toHaveBeenCalledWith({
      sessionId: 7,
      eventType: "source.added",
      payload: expect.objectContaining({
        sourceId: 21,
        kind: "file",
        filename: "spec.pdf",
        mimeType: "application/pdf",
        sizeBytes: 2048,
        converter: "markitdown",
        conversionStatus: "awaiting_upload",
      }),
      actorType: "user",
      actorId: "kompallik",
    });
  });

  it("requestUpload records media uploads for voxtral conversion", async () => {
    const { service, composeRepository, uploads } = buildService();
    composeRepository.createUploadSource.mockResolvedValue(21);
    uploads.createUploadUrl.mockResolvedValue({
      sourceId: 21,
      uploadUrl: "https://s3/put",
      s3KeyRaw: "compose/7/raw/21-demo.mp4",
      expiresInSeconds: 900,
    });

    await service.requestUpload({
      sessionId: 7,
      filename: "demo.mp4",
      mimeType: "video/mp4",
      sizeBytes: 2048,
    });

    expect(composeRepository.createUploadSource).toHaveBeenCalledWith(
      expect.objectContaining({ converter: "voxtral" }),
    );
  });

  it("getSourcePreview returns a presigned URL for an uploaded image in the session", async () => {
    const { service, composeRepository, uploads } = buildService();
    composeRepository.getSessionSource.mockResolvedValue({
      id: 21,
      sessionId: 7,
      kind: "file",
      originalFilename: "screen.png",
      mimeType: "image/png",
      sizeBytes: 2048,
      sourceUrl: null,
      s3KeyRaw: "compose/7/raw/21-screen.png",
      converter: "markitdown",
      markdownPath: null,
      markdownContent: null,
      conversionStatus: "unsupported",
      conversionStartedAt: null,
      conversionAttempts: 1,
      conversionLeaseExpiresAt: null,
      errorMessage: null,
      createdAt: "2026-06-02T00:00:00.000Z",
      updatedAt: "2026-06-02T00:00:00.000Z",
    });
    uploads.createPreviewUrl.mockResolvedValue("https://s3/get");

    const result = await service.getSourcePreview({
      sessionId: 7,
      sourceId: 21,
    });

    expect(result).toEqual({
      filename: "screen.png",
      mimeType: "image/png",
      url: "https://s3/get",
    });
    expect(uploads.createPreviewUrl).toHaveBeenCalledWith({
      s3KeyRaw: "compose/7/raw/21-screen.png",
      filename: "screen.png",
      mimeType: "image/png",
    });
  });

  it("requestUpload rejects a blank filename", async () => {
    const { service } = buildService();
    await expect(
      service.requestUpload({
        sessionId: 7,
        filename: "  ",
        mimeType: null,
        sizeBytes: null,
      }),
    ).rejects.toThrow(/filename/i);
  });

  it("confirmUpload marks the source uploaded and kicks the conversion worker", async () => {
    const { service, composeRepository, conversionWorker } = buildService();
    await service.confirmUpload({
      sessionId: 7,
      sourceId: 21,
      actor: "kompallik",
    });
    expect(composeRepository.markSourceUploaded).toHaveBeenCalledWith({
      sessionId: 7,
      sourceId: 21,
    });
    expect(composeRepository.markSessionContextDirty).toHaveBeenCalledWith(7);
    expect(composeRepository.appendSessionEvent).toHaveBeenCalledWith({
      sessionId: 7,
      eventType: "source.uploaded",
      payload: {
        sourceId: 21,
        conversionStatus: "pending",
      },
      actorType: "user",
      actorId: "kompallik",
    });
    expect(conversionWorker.drain).toHaveBeenCalled();
  });

  it("source conversion kicks do not wait for the full pending backlog", async () => {
    const actions: Array<{
      name: string;
      run: (
        service: ComposeService,
        repository: ReturnType<typeof buildService>["composeRepository"],
      ) => Promise<unknown>;
    }> = [
      {
        name: "confirmUpload",
        run: (service) => service.confirmUpload({ sessionId: 7, sourceId: 21 }),
      },
      {
        name: "addYoutube",
        run: (service, repository) => {
          repository.createYoutubeSource.mockResolvedValue(22);
          return service.addYoutube({
            sessionId: 7,
            url: "https://youtu.be/x",
          });
        },
      },
      {
        name: "addConfluence",
        run: (service) =>
          service.addConfluence({
            sessionId: 7,
            url: "https://wiki.example.com/display/PROJ/Page",
          }),
      },
      {
        name: "reconvert",
        run: (service) => service.reconvert({ sessionId: 7, sourceId: 21 }),
      },
      {
        name: "reconvertFailedSources",
        run: (service, repository) => {
          repository.reconvertFailedSessionSources.mockResolvedValueOnce(2);
          return service.reconvertFailedSources({ sessionId: 7 });
        },
      },
    ];

    for (const action of actions) {
      const { service, composeRepository, conversionWorker } = buildService();
      conversionWorker.drain.mockReturnValue(new Promise(() => undefined));

      const result = await Promise.race([
        action.run(service, composeRepository).then(() => "returned"),
        new Promise((resolve) =>
          setTimeout(() => resolve(`${action.name} waited`), 25),
        ),
      ]);

      expect(result).toBe("returned");
      expect(conversionWorker.drain).toHaveBeenCalledTimes(1);
    }
  });

  it("addYoutube rejects when the session does not exist", async () => {
    const { service, composeRepository } = buildService();
    composeRepository.getSession.mockResolvedValue(null);
    await expect(
      service.addYoutube({ sessionId: 999, url: "https://youtu.be/x" }),
    ).rejects.toThrow(/not found/i);
    expect(composeRepository.createYoutubeSource).not.toHaveBeenCalled();
  });

  it("addYoutube rejects an archived session", async () => {
    const { service, composeRepository } = buildService();
    composeRepository.getSession.mockResolvedValue(
      sessionSummary({ status: "archived" }),
    );
    await expect(
      service.addYoutube({ sessionId: 7, url: "https://youtu.be/x" }),
    ).rejects.toThrow(/not found/i);
    expect(composeRepository.createYoutubeSource).not.toHaveBeenCalled();
  });

  it("addConfluence rejects when the session does not exist", async () => {
    const { service, composeRepository } = buildService();
    composeRepository.getSession.mockResolvedValue(null);
    await expect(
      service.addConfluence({
        sessionId: 999,
        url: "https://wiki.example.com/display/PROJ/Page",
      }),
    ).rejects.toThrow(/not found/i);
    expect(composeRepository.createConfluenceSource).not.toHaveBeenCalled();
  });

  it("addConfluence rejects an archived session", async () => {
    const { service, composeRepository } = buildService();
    composeRepository.getSession.mockResolvedValue(
      sessionSummary({ status: "archived" }),
    );
    await expect(
      service.addConfluence({
        sessionId: 7,
        url: "https://wiki.example.com/display/PROJ/Page",
      }),
    ).rejects.toThrow(/not found/i);
    expect(composeRepository.createConfluenceSource).not.toHaveBeenCalled();
  });

  it("requestUpload rejects sizes above the configured maximum", async () => {
    const { service } = buildService();
    // Default max is 500MB.
    await expect(
      service.requestUpload({
        sessionId: 7,
        filename: "huge.mp4",
        mimeType: "video/mp4",
        sizeBytes: 524_288_000 + 1,
      }),
    ).rejects.toThrow(/maximum size/i);
  });

  it("requestUpload accepts a size at the configured maximum", async () => {
    const { service, composeRepository, uploads } = buildService();
    composeRepository.createUploadSource.mockResolvedValue(21);
    uploads.createUploadUrl.mockResolvedValue({
      sourceId: 21,
      uploadUrl: "https://s3/put",
      s3KeyRaw: "compose/7/raw/21-spec.pdf",
      expiresInSeconds: 900,
    });
    await expect(
      service.requestUpload({
        sessionId: 7,
        filename: "big.pdf",
        mimeType: "application/pdf",
        sizeBytes: 524_288_000,
      }),
    ).resolves.toMatchObject({ uploadUrl: "https://s3/put" });
  });

  it("addYoutube mints a youtube source and kicks the worker", async () => {
    const { service, composeRepository, conversionWorker } = buildService();
    composeRepository.createYoutubeSource.mockResolvedValue(22);
    await service.addYoutube({
      sessionId: 7,
      url: "https://youtu.be/x",
      actor: "kompallik",
    });
    expect(composeRepository.createYoutubeSource).toHaveBeenCalledWith({
      sessionId: 7,
      url: "https://youtu.be/x",
    });
    expect(composeRepository.markSessionContextDirty).toHaveBeenCalledWith(7);
    expect(composeRepository.appendSessionEvent).toHaveBeenCalledWith({
      sessionId: 7,
      eventType: "source.added",
      payload: expect.objectContaining({
        sourceId: 22,
        kind: "youtube",
        sourceUrl: "https://youtu.be/x",
        conversionStatus: "pending",
      }),
      actorType: "user",
      actorId: "kompallik",
    });
    expect(conversionWorker.drain).toHaveBeenCalled();
  });

  it("addYoutube rejects a blank url", async () => {
    const { service } = buildService();
    await expect(
      service.addYoutube({ sessionId: 7, url: "  " }),
    ).rejects.toThrow(/url/i);
  });

  it("addYoutube rejects non-youtube or non-public urls", async () => {
    const { service } = buildService();
    await expect(
      service.addYoutube({
        sessionId: 7,
        url: "https://example.com/watch?v=x",
      }),
    ).rejects.toThrow(/not allowed/i);
    await expect(
      service.addYoutube({ sessionId: 7, url: "http://youtu.be/x" }),
    ).rejects.toThrow(/https/i);
  });

  it("addConfluence mints a pending URL source and kicks the worker", async () => {
    const { service, composeRepository, conversionWorker } = buildService();
    await service.addConfluence({
      sessionId: 7,
      url: " https://wiki.example.com/display/PROJ/Page ",
      actor: "kompallik",
    });
    expect(composeRepository.createConfluenceSource).toHaveBeenCalledWith({
      sessionId: 7,
      url: "https://wiki.example.com/display/PROJ/Page",
    });
    expect(composeRepository.markSessionContextDirty).toHaveBeenCalledWith(7);
    expect(composeRepository.appendSessionEvent).toHaveBeenCalledWith({
      sessionId: 7,
      eventType: "source.added",
      payload: expect.objectContaining({
        sourceId: 14,
        kind: "confluence",
        sourceUrl: "https://wiki.example.com/display/PROJ/Page",
        conversionStatus: "pending",
      }),
      actorType: "user",
      actorId: "kompallik",
    });
    expect(conversionWorker.drain).toHaveBeenCalled();
  });

  it("addConfluence rejects a blank url", async () => {
    const { service } = buildService();
    await expect(
      service.addConfluence({ sessionId: 7, url: "  " }),
    ).rejects.toThrow(/url/i);
  });

  it("addConfluence rejects local or non-https urls", async () => {
    const { service } = buildService();
    await expect(
      service.addConfluence({
        sessionId: 7,
        url: "http://wiki.example.com/display/A",
      }),
    ).rejects.toThrow(/https/i);
    await expect(
      service.addConfluence({
        sessionId: 7,
        url: "https://127.0.0.1/display/A",
      }),
    ).rejects.toThrow(/public/i);
  });

  it("addJira fetches Jira markdown and stores it as a converted source", async () => {
    const { service, composeRepository, jiraSourceFetcher } = buildService();

    await service.addJira({
      sessionId: 7,
      jiraKey: " cpdev-123 ",
      actor: "kompallik",
    });

    expect(jiraSourceFetcher.fetchMarkdown).toHaveBeenCalledWith("CPDEV-123");
    expect(composeRepository.createJiraSource).toHaveBeenCalledWith({
      sessionId: 7,
      jiraKey: "CPDEV-123",
      title: "CPDEV-123 Add export",
      sourceUrl: "https://jira.example.com/browse/CPDEV-123",
      markdownContent: "# CPDEV-123 Add export\n\nBuild CSV export.",
    });
    expect(composeRepository.completeSourceConversion).toHaveBeenCalledWith({
      sourceId: 13,
      markdownPath: null,
      markdownContent: "# CPDEV-123 Add export\n\nBuild CSV export.",
    });
    expect(composeRepository.markSessionContextDirty).toHaveBeenCalledWith(7);
    expect(composeRepository.appendSessionEvent).toHaveBeenCalledWith({
      sessionId: 7,
      eventType: "source.added",
      payload: expect.objectContaining({
        sourceId: 13,
        kind: "jira",
        jiraKey: "CPDEV-123",
        title: "CPDEV-123 Add export",
        sourceUrl: "https://jira.example.com/browse/CPDEV-123",
        conversionStatus: "converted",
      }),
      actorType: "user",
      actorId: "kompallik",
    });
  });

  it("addJira rejects an invalid Jira key", async () => {
    const { service } = buildService();
    await expect(
      service.addJira({ sessionId: 7, jiraKey: "not a key" }),
    ).rejects.toThrow(/Jira key/i);
  });

  it("listSources returns the session's sources", async () => {
    const { service, composeRepository } = buildService();
    composeRepository.listSessionSources.mockResolvedValue([]);
    expect(await service.listSources(7)).toEqual([]);
  });

  it("content read APIs reject archived sessions before loading content", async () => {
    const { service, composeRepository } = buildService();
    composeRepository.getSession.mockResolvedValue(
      sessionSummary({ status: "archived" }),
    );

    await expect(service.listSources(7)).rejects.toThrow(/not found/i);
    await expect(service.listMessages(7)).rejects.toThrow(/not found/i);
    expect(composeRepository.listSessionSources).not.toHaveBeenCalled();
    expect(composeRepository.listMessages).not.toHaveBeenCalled();
  });

  it("reconvert resets a source and kicks the worker", async () => {
    const { service, composeRepository, conversionWorker } = buildService();
    await service.reconvert({ sessionId: 7, sourceId: 21 });
    expect(composeRepository.reconvertSource).toHaveBeenCalledWith({
      sessionId: 7,
      sourceId: 21,
    });
    expect(composeRepository.markSessionContextDirty).toHaveBeenCalledWith(7);
    expect(conversionWorker.drain).toHaveBeenCalled();
  });

  it("reconvertFailedSources queues retryable sources and kicks the worker only when needed", async () => {
    const { service, composeRepository, conversionWorker } = buildService();
    composeRepository.reconvertFailedSessionSources.mockResolvedValueOnce(2);

    await expect(
      service.reconvertFailedSources({ sessionId: 7 }),
    ).resolves.toEqual({ queued: 2 });

    expect(composeRepository.getSession).toHaveBeenCalledWith(7);
    expect(
      composeRepository.reconvertFailedSessionSources,
    ).toHaveBeenCalledWith(7);
    expect(composeRepository.markSessionContextDirty).toHaveBeenCalledWith(7);
    expect(conversionWorker.drain).toHaveBeenCalledTimes(1);
  });

  it("reconvertFailedSources returns zero without dirtying context when no sources match", async () => {
    const { service, composeRepository, conversionWorker } = buildService();

    await expect(
      service.reconvertFailedSources({ sessionId: 7 }),
    ).resolves.toEqual({ queued: 0 });

    expect(composeRepository.markSessionContextDirty).not.toHaveBeenCalled();
    expect(conversionWorker.drain).not.toHaveBeenCalled();
  });

  it("deleteSource records a session-scoped source removal", async () => {
    const { service, composeRepository, sseHub } = buildService();

    await expect(
      service.deleteSource({ sessionId: 7, sourceId: 21 }),
    ).resolves.toEqual(sourceDeletionSummary());

    expect(composeRepository.deleteSessionSource).toHaveBeenCalledWith({
      sessionId: 7,
      sourceId: 21,
      actor: null,
      undoWindowMinutes: 10,
    });
    expect(composeRepository.markSessionContextDirty).not.toHaveBeenCalled();
    expect(sseHub.publish).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        status: "idle",
        message: "Source removed with 1 dependent artifact",
      }),
    );
  });

  it("deleteSource rejects a source outside the session", async () => {
    const { service, composeRepository } = buildService();
    composeRepository.deleteSessionSource.mockResolvedValueOnce(null);

    await expect(
      service.deleteSource({ sessionId: 7, sourceId: 21 }),
    ).rejects.toThrow("Compose source 21 was not found in session 7");
  });

  it("lists recoverable source deletions for a readable session", async () => {
    const { service, composeRepository } = buildService();

    await expect(
      service.listUndoableSourceDeletions({ sessionId: 7 }),
    ).resolves.toEqual([sourceDeletionSummary()]);
    expect(composeRepository.listUndoableSourceDeletions).toHaveBeenCalledWith(
      7,
    );
  });

  it("restores the original source and restarts conversion", async () => {
    const { service, composeRepository, conversionWorker, sseHub } =
      buildService();

    await expect(
      service.restoreDeletedSource({ sessionId: 7, sourceId: 21 }),
    ).resolves.toEqual(sourceDeletionSummary({ status: "restored" }));
    expect(composeRepository.restoreSessionSource).toHaveBeenCalledWith({
      sessionId: 7,
      sourceId: 21,
      actor: null,
    });
    expect(conversionWorker.drain).toHaveBeenCalledOnce();
    expect(sseHub.publish).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ status: "thinking" }),
    );
  });

  it("rejects restore after the source undo window expires", async () => {
    const { service, composeRepository, conversionWorker } = buildService();
    composeRepository.restoreSessionSource.mockResolvedValueOnce(null);

    await expect(
      service.restoreDeletedSource({ sessionId: 7, sourceId: 21 }),
    ).rejects.toThrow("cannot be restored");
    expect(conversionWorker.drain).not.toHaveBeenCalled();
  });

  it("analyze prepares the workspace, runs the agent without resume, persists session id + readiness + assistant message, and publishes", async () => {
    const { service, composeRepository, chatAgent, workspaceManager, sseHub } =
      buildService();
    composeRepository.getSession.mockResolvedValue(
      sessionSummary({ id: 7, workspacePath: "/w/7", claudeSessionId: null }),
    );
    chatAgent.run.mockResolvedValue({
      envelope: {
        reply: "Which repo?",
        readiness: {
          ready: false,
          openQuestions: ["repo?"],
          summary: "need repo",
        },
        contextMarkdown: "# Context",
      },
      sessionId: "sess-1",
      metrics: {},
    });

    const result = await service.analyze({ sessionId: 7 });
    await flushAsyncTurns();

    expect(workspaceManager.prepare).toHaveBeenCalled();
    expect(chatAgent.run.mock.calls[0][0].mode).toBe("analyze");
    expect(chatAgent.run.mock.calls[0][0].resumeSessionId).toBeNull();
    expect(composeRepository.setClaudeSessionId).toHaveBeenCalledWith({
      sessionId: 7,
      claudeSessionId: "sess-1",
    });
    expect(
      composeRepository.appendAssistantMessageIfSessionActive,
    ).toHaveBeenCalledWith({
      sessionId: 7,
      content: "Which repo?",
      contextVersionUsed: null,
    });
    expect(composeRepository.setReadiness).toHaveBeenCalledWith({
      sessionId: 7,
      readiness: {
        ready: false,
        openQuestions: ["repo?"],
        summary: "need repo",
      },
    });
    expect(result).toEqual({ accepted: true });
  });

  it("routes legacy chat execution through the legacy_compose_chat executor seam", async () => {
    const legacyChatExecutor = {
      execute: vi.fn().mockResolvedValue({
        envelope: {
          reply: "Which repo?",
          readiness: {
            ready: false,
            openQuestions: ["repo?"],
            summary: "need repo",
          },
          contextMarkdown: "# Context",
        },
        sessionId: "sess-1",
        metrics: {},
      }),
    };
    const { service, chatAgent } = buildService({ legacyChatExecutor });

    await service.analyze({ sessionId: 7 });
    await flushAsyncTurns();

    expect(legacyChatExecutor.execute).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "analyze" }),
    );
    expect(chatAgent.run).not.toHaveBeenCalled();
  });

  it("records analyze and chat activity lifecycle metadata", async () => {
    const { service, composeRepository, chatAgent } = buildService();
    chatAgent.run.mockResolvedValue({
      envelope: {
        reply: "Ready.",
        readiness: { ready: true, openQuestions: [], summary: "ready" },
      },
      sessionId: "sess-1",
      metrics: {},
    });

    await service.analyze({
      sessionId: 7,
      actor: "kompallik",
      repositoryIds: [3],
    });
    await flushAsyncTurns();

    expect(composeRepository.recordSessionActivity).toHaveBeenCalledWith({
      sessionId: 7,
      action: "analyze_requested",
      actor: "kompallik",
    });
    expect(composeRepository.recordSessionActivity).toHaveBeenCalledWith({
      sessionId: 7,
      action: "analyze_started",
      actor: null,
      activeTurn: "started",
    });
    expect(composeRepository.recordSessionActivity).toHaveBeenCalledWith({
      sessionId: 7,
      action: "analyze_completed",
      actor: null,
      activeTurn: "finished",
    });

    composeRepository.recordSessionActivity.mockClear();
    await service.postMessage({
      sessionId: 7,
      content: "Use medhok-monorepo",
      actor: "kompallik",
    });
    await flushAsyncTurns();

    expect(composeRepository.recordSessionActivity).toHaveBeenCalledWith({
      sessionId: 7,
      action: "message_received",
      actor: "kompallik",
    });
    expect(composeRepository.recordSessionActivity).toHaveBeenCalledWith({
      sessionId: 7,
      action: "chat_completed",
      actor: null,
      activeTurn: "finished",
    });
  });

  it("does not write turn lifecycle activity when a queued turn dequeues after archive", async () => {
    const { service, composeRepository, chatAgent } = buildService();
    composeRepository.getSession
      .mockResolvedValueOnce(sessionSummary())
      .mockResolvedValue(sessionSummary({ status: "archived" }));

    await expect(
      service.postMessage({ sessionId: 7, content: "Use medhok-monorepo" }),
    ).resolves.toEqual({ accepted: true });
    await flushAsyncTurns();

    expect(chatAgent.run).not.toHaveBeenCalled();
    expect(composeRepository.recordSessionActivity).toHaveBeenCalledWith({
      sessionId: 7,
      action: "message_received",
      actor: null,
    });
    const actions = composeRepository.recordSessionActivity.mock.calls.map(
      ([input]) => input.action,
    );
    expect(actions).not.toContain("chat_started");
    expect(actions).not.toContain("chat_failed");
  });

  it("requestCodeResearch enqueues a code research task when the executor is enabled", async () => {
    vi.stubEnv("SPEC_FACTORY_RESEARCH_EXECUTOR", " Claude_Agent_Sdk ");
    vi.stubEnv("SPEC_FACTORY_RESEARCH_INGRESS_ENABLED", "true");
    vi.stubEnv("SPEC_FACTORY_RESEARCH_COST_CEILING_USD", "10");
    const { service, composeRepository, sseHub } = buildService();

    await expect(
      service.requestCodeResearch({
        sessionId: 7,
        question: "Where is retry logic implemented?",
        parentSourceIds: [11, 12],
        contextVersionUsed: 4,
        actor: "kompallik",
      }),
    ).resolves.toEqual({
      accepted: true,
      agentTaskId: 501,
      capability: "code_research",
      status: "queued",
    });

    expect(composeRepository.createAgentTask).toHaveBeenCalledWith({
      sessionId: 7,
      turnJobId: null,
      capability: "code_research",
      executorType: "code_research",
      priority: 70,
      maxAttempts: 2,
      outputSourceId: null,
      input: {
        question: "Where is retry logic implemented?",
        parentSourceIds: [11, 12],
        contextVersionUsed: 4,
        maxCostUsd: 3,
      },
    });
    expect(composeRepository.appendSessionEvent).toHaveBeenCalledWith({
      sessionId: 7,
      eventType: "task.queued",
      payload: {
        capability: "code_research",
        executorType: "code_research",
        question: "Where is retry logic implemented?",
        parentSourceIds: [11, 12],
        contextVersionUsed: 4,
        maxCostUsd: 3,
      },
      actorType: "user",
      actorId: "kompallik",
      agentTaskId: 501,
      contextVersion: 4,
    });
    expect(composeRepository.recordSessionActivity).toHaveBeenCalledWith({
      sessionId: 7,
      action: "code_research_requested",
      actor: "kompallik",
    });
    expect(sseHub.publish).toHaveBeenCalledWith(7, {
      type: "status",
      status: "thinking",
      message: "Code research queued",
    });
  });

  it("requestCodeResearch reserves the configured per-task research cost cap", async () => {
    vi.stubEnv("SPEC_FACTORY_RESEARCH_EXECUTOR", "claude_agent_sdk");
    vi.stubEnv("SPEC_FACTORY_RESEARCH_INGRESS_ENABLED", "true");
    vi.stubEnv("SPEC_FACTORY_RESEARCH_COST_CEILING_USD", "10");
    vi.stubEnv("SPEC_FACTORY_RESEARCH_MAX_COST_USD", "2.25");
    const { service, composeRepository } = buildService();

    await expect(
      service.requestCodeResearch({
        sessionId: 7,
        question: "Where is retry logic implemented?",
      }),
    ).resolves.toMatchObject({
      accepted: true,
      capability: "code_research",
      status: "queued",
    });

    expect(composeRepository.createAgentTask).toHaveBeenCalledWith({
      sessionId: 7,
      turnJobId: null,
      capability: "code_research",
      executorType: "code_research",
      priority: 70,
      maxAttempts: 2,
      outputSourceId: null,
      input: {
        question: "Where is retry logic implemented?",
        parentSourceIds: [],
        contextVersionUsed: null,
        maxCostUsd: 2.25,
      },
    });
  });

  it("requestCodeResearch fails closed when the research budget ceiling is unset", async () => {
    vi.stubEnv("SPEC_FACTORY_RESEARCH_EXECUTOR", "claude_agent_sdk");
    vi.stubEnv("SPEC_FACTORY_RESEARCH_INGRESS_ENABLED", "true");
    const { service, composeRepository } = buildService();

    await expect(
      service.requestCodeResearch({
        sessionId: 7,
        question: "Where is retry logic implemented?",
      }),
    ).rejects.toThrow("research_budget_rejected:research_budget_unconfigured");

    expect(composeRepository.createAgentTask).not.toHaveBeenCalled();
  });

  it("requestCodeResearch rejects when the session research budget would be exceeded", async () => {
    vi.stubEnv("SPEC_FACTORY_RESEARCH_EXECUTOR", "claude_agent_sdk");
    vi.stubEnv("SPEC_FACTORY_RESEARCH_INGRESS_ENABLED", "true");
    vi.stubEnv("SPEC_FACTORY_RESEARCH_COST_CEILING_USD", "3");
    const { service, composeRepository } = buildService();
    composeRepository.getSessionResearchBudgetUsage.mockResolvedValueOnce({
      spentCostUsd: 0.5,
      reservedCostUsd: 0.25,
      researchTasks24h: 0,
      inFlightTasks: 0,
    });

    await expect(
      service.requestCodeResearch({
        sessionId: 7,
        question: "Where is retry logic implemented?",
      }),
    ).rejects.toThrow("research_budget_rejected:budget_exceeded");

    expect(composeRepository.createAgentTask).not.toHaveBeenCalled();
  });

  it("requestCodeResearch is disabled unless the executor and ingress are both configured", async () => {
    const { service, composeRepository } = buildService();

    await expect(
      service.requestCodeResearch({
        sessionId: 7,
        question: "Where is retry logic implemented?",
      }),
    ).rejects.toThrow("code_research_enqueue_disabled");

    expect(composeRepository.createAgentTask).not.toHaveBeenCalled();

    vi.stubEnv("SPEC_FACTORY_RESEARCH_EXECUTOR", "claude_agent_sdk");
    await expect(
      service.requestCodeResearch({
        sessionId: 7,
        question: "Where is retry logic implemented?",
      }),
    ).rejects.toThrow("code_research_enqueue_disabled");

    expect(composeRepository.createAgentTask).not.toHaveBeenCalled();
  });

  it("requestCodeResearch does not enqueue against archived sessions", async () => {
    vi.stubEnv("SPEC_FACTORY_RESEARCH_EXECUTOR", "claude_agent_sdk");
    vi.stubEnv("SPEC_FACTORY_RESEARCH_INGRESS_ENABLED", "true");
    const { service, composeRepository } = buildService();
    composeRepository.getSession.mockResolvedValue(
      sessionSummary({ status: "archived" }),
    );

    await expect(
      service.requestCodeResearch({
        sessionId: 7,
        question: "Where is retry logic implemented?",
      }),
    ).rejects.toThrow("Compose session 7 was not found");

    expect(composeRepository.createAgentTask).not.toHaveBeenCalled();
  });

  it("writes the grounding repository context into the workspace and passes selected ids to grounding", async () => {
    const { service, workspaceManager, chatAgent, repoGrounding } =
      buildService();
    repoGrounding.groundRepos.mockResolvedValue({
      codeRepoIds: ["rid-medhok-monorepo"],
      repositoriesMarkdown:
        "# Selected code repositories\n- medhok-monorepo\n- cp-autonomous-ai-agents-platform",
      manifest: [],
    });
    chatAgent.run.mockResolvedValue({
      envelope: {
        reply: "Ready.",
        readiness: { ready: true, openQuestions: [], summary: "ready" },
      },
      sessionId: "sess-1",
      metrics: {},
    });

    await service.analyze({ sessionId: 7, repositoryIds: [5, 3, 5] });
    await flushAsyncTurns();

    // Selected repository ids are normalized (deduped) and passed to grounding.
    expect(repoGrounding.groundRepos).toHaveBeenCalledWith(
      expect.objectContaining({ selectedRepositoryIds: [5, 3] }),
    );
    expect(workspaceManager.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryContextMarkdown: expect.stringContaining("medhok-monorepo"),
      }),
    );
    expect(
      workspaceManager.prepare.mock.calls[0][0].repositoryContextMarkdown,
    ).toContain("cp-autonomous-ai-agents-platform");
  });

  it("analyze with an idempotency key creates a durable analyze turn", async () => {
    const { service, composeRepository, chatAgent } = buildService();
    chatAgent.run.mockResolvedValue({
      envelope: {
        reply: "Ready.",
        readiness: { ready: true, openQuestions: [], summary: "ready" },
      },
      sessionId: "sess-1",
      metrics: {},
    });

    const result = await service.analyze({
      sessionId: 7,
      repositoryIds: [5, 3, 5],
      reset: true,
      actor: "kompallik",
      idempotencyKey: "analyze-abc",
    });

    expect(composeRepository.createAnalyzeTurn).toHaveBeenCalledWith({
      sessionId: 7,
      idempotencyKey: "analyze-abc",
      requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      resetSessionProgress: true,
    });
    expect(composeRepository.resetSessionProgress).not.toHaveBeenCalled();
    expect(composeRepository.appendSessionEvent).toHaveBeenCalledWith({
      sessionId: 7,
      eventType: "turn.queued",
      payload: {
        turnJobId: 102,
        turnKind: "analyze",
        userMessageId: null,
        status: "queued",
        repositoryIds: [5, 3],
      },
      actorType: "user",
      actorId: "kompallik",
      turnJobId: 102,
    });
    expect(result).toEqual({
      accepted: true,
      messageId: null,
      turnJobId: 102,
      status: "queued",
    });
  });

  it("analyze with a duplicate idempotency key does not reset or enqueue again", async () => {
    const { service, composeRepository, chatAgent } = buildService();
    composeRepository.createAnalyzeTurn.mockResolvedValueOnce({
      turnJobId: 102,
      messageId: null,
      status: "queued",
      deduplicated: true,
    });

    const result = await service.analyze({
      sessionId: 7,
      repositoryIds: [3],
      reset: true,
      actor: "kompallik",
      idempotencyKey: "analyze-abc",
    });

    expect(result).toEqual({
      accepted: true,
      messageId: null,
      turnJobId: 102,
      status: "queued",
    });
    expect(composeRepository.createAnalyzeTurn).toHaveBeenCalledWith({
      sessionId: 7,
      idempotencyKey: "analyze-abc",
      requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      resetSessionProgress: true,
    });
    expect(composeRepository.resetSessionProgress).not.toHaveBeenCalled();
    expect(composeRepository.appendSessionEvent).toHaveBeenCalledWith({
      sessionId: 7,
      eventType: "turn.duplicate_suppressed",
      payload: {
        turnJobId: 102,
        turnKind: "analyze",
        userMessageId: null,
        status: "queued",
      },
      actorType: "user",
      actorId: "kompallik",
      turnJobId: 102,
    });
    expect(chatAgent.run).not.toHaveBeenCalled();
  });

  it("analyze retries without resume when the stored Claude conversation is stale", async () => {
    const { service, composeRepository, chatAgent } = buildService();
    composeRepository.getSession.mockResolvedValue(
      sessionSummary({
        id: 7,
        workspacePath: "/w/7",
        claudeSessionId: "stale-session",
      }),
    );
    chatAgent.run
      .mockRejectedValueOnce(
        new Error("No conversation found with session ID: stale-session"),
      )
      .mockResolvedValueOnce({
        envelope: {
          reply: "I read the sources.",
          readiness: { ready: true, openQuestions: [], summary: "ready" },
          contextMarkdown: "# Context",
        },
        sessionId: "fresh-session",
        metrics: {},
      });

    const result = await service.analyze({ sessionId: 7 });
    await flushAsyncTurns();

    expect(chatAgent.run).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ resumeSessionId: "stale-session" }),
    );
    expect(chatAgent.run).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ resumeSessionId: null }),
    );
    expect(composeRepository.setClaudeSessionId).toHaveBeenCalledWith({
      sessionId: 7,
      claudeSessionId: null,
    });
    expect(composeRepository.setClaudeSessionId).toHaveBeenCalledWith({
      sessionId: 7,
      claudeSessionId: "fresh-session",
    });
    expect(result).toEqual({ accepted: true });
  });

  it("analyze rejects while any source is still uploading or converting", async () => {
    const { service, composeRepository, chatAgent } = buildService();
    composeRepository.listSessionSources.mockResolvedValueOnce([
      {
        id: 21,
        sessionId: 7,
        kind: "file",
        originalFilename: "requirements.docx",
        conversionStatus: "pending",
        errorMessage: null,
      },
    ]);

    await expect(service.analyze({ sessionId: 7 })).rejects.toThrow(
      "Cannot analyze Compose session 7 until sources finish processing: requirements.docx (pending)",
    );
    expect(chatAgent.run).not.toHaveBeenCalled();
  });

  it("analyze with reset clears progress before enqueuing; without reset it does not", async () => {
    const { service, composeRepository, chatAgent } = buildService();
    chatAgent.run.mockResolvedValue({
      envelope: {
        reply: "ok",
        readiness: { ready: false, openQuestions: [], summary: "" },
      },
      sessionId: "claude-1",
      metrics: { durationMs: 1, toolCalls: 0 },
    });

    await service.analyze({ sessionId: 7, reset: true });
    await flushAsyncTurns();
    expect(composeRepository.resetSessionProgress).toHaveBeenCalledWith(7);

    composeRepository.resetSessionProgress.mockClear();
    await service.analyze({ sessionId: 7 });
    await flushAsyncTurns();
    expect(composeRepository.resetSessionProgress).not.toHaveBeenCalled();
  });

  it("postMessage persists the user turn, resumes the warm session, persists the assistant turn + readiness", async () => {
    const { service, composeRepository, chatAgent } = buildService();
    composeRepository.getSession.mockResolvedValue(
      sessionSummary({
        id: 7,
        workspacePath: "/w/7",
        claudeSessionId: "sess-1",
      }),
    );
    chatAgent.run.mockResolvedValue({
      envelope: {
        reply: "Got it.",
        readiness: { ready: true, openQuestions: [], summary: "ready" },
      },
      sessionId: "sess-1",
      metrics: {},
    });

    const result = await service.postMessage({
      sessionId: 7,
      content: "billing-service",
    });
    await flushAsyncTurns();

    expect(composeRepository.appendMessage.mock.calls[0][0]).toEqual({
      sessionId: 7,
      role: "user",
      content: "billing-service",
    });
    expect(
      composeRepository.appendAssistantMessageIfSessionActive,
    ).toHaveBeenCalledWith({
      sessionId: 7,
      content: "Got it.",
      contextVersionUsed: null,
    });
    expect(chatAgent.run.mock.calls[0][0].resumeSessionId).toBe("sess-1");
    expect(chatAgent.run.mock.calls[0][0].latestUserMessage).toBe(
      "billing-service",
    );
    expect(result).toEqual({ accepted: true });
  });

  it("executeClaimedTurn answers trivial greetings without coordinator or legacy latency", async () => {
    const chatCoordinator = {
      decide: vi.fn().mockResolvedValue({
        action: "answer",
        answer: "This should not be used.",
        confidence: "high",
        contextVersionUsed: 4,
      }),
    };
    const { service, composeRepository, chatAgent, sseHub } = buildService({
      chatCoordinator,
    });
    composeRepository.getSession.mockResolvedValue(
      sessionSummary({ latestContextVersion: 4 }),
    );
    composeRepository.listMessages.mockResolvedValue([
      {
        id: 51,
        sessionId: 7,
        role: "user",
        content: "hi",
        createdAt: "2026-06-02T00:00:00.000Z",
      },
    ]);

    await service.executeClaimedTurn({
      id: 101,
      sessionId: 7,
      turnKind: "chat",
      userMessageId: 51,
      status: "running",
      leaseGeneration: 1,
      activeWorkerId: "turn-worker-a",
    });

    expect(chatCoordinator.decide).not.toHaveBeenCalled();
    expect(chatAgent.run).not.toHaveBeenCalled();
    expect(composeRepository.createAgentTask).not.toHaveBeenCalled();
    expect(
      composeRepository.completeTurnWithAssistantMessage,
    ).toHaveBeenCalledWith({
      turnJobId: 101,
      sessionId: 7,
      content: "Hi. I'm here. What would you like to do next?",
      contextVersionUsed: 4,
      finalPayload: {
        action: "fast_ack",
        reason: "trivial_chat_acknowledgement",
        answer: "Hi. I'm here. What would you like to do next?",
      },
      lease: {
        workerId: "turn-worker-a",
        leaseGeneration: 1,
      },
    });
    expect(composeRepository.appendSessionEvent).toHaveBeenCalledWith({
      sessionId: 7,
      eventType: "turn.completed",
      payload: {
        turnJobId: 101,
        turnKind: "chat",
        assistantMessageId: 52,
        coordinatorAction: "fast_ack",
      },
      actorType: "system",
      actorId: "turn-worker-a",
      turnJobId: 101,
    });
    expect(sseHub.publish).toHaveBeenCalledWith(7, {
      type: "message",
      role: "assistant",
      content: "Hi. I'm here. What would you like to do next?",
    });
    expect(sseHub.publish).toHaveBeenCalledWith(7, {
      type: "status",
      status: "idle",
    });
  });

  it("executeClaimedTurn retries a deadlocked greeting final write", async () => {
    const { service, composeRepository, chatAgent } = buildService();
    composeRepository.getSession.mockResolvedValue(
      sessionSummary({ latestContextVersion: 4 }),
    );
    composeRepository.listMessages.mockResolvedValue([
      {
        id: 51,
        sessionId: 7,
        role: "user",
        content: "hi",
        createdAt: "2026-06-02T00:00:00.000Z",
      },
    ]);
    composeRepository.completeTurnWithAssistantMessage
      .mockRejectedValueOnce(
        Object.assign(new Error("Deadlock found when trying to get lock"), {
          code: "ER_LOCK_DEADLOCK",
          errno: 1213,
        }),
      )
      .mockResolvedValueOnce({
        assistantMessageId: 52,
        deduplicated: false,
      });

    await service.executeClaimedTurn({
      id: 101,
      sessionId: 7,
      turnKind: "chat",
      userMessageId: 51,
      status: "running",
      leaseGeneration: 1,
      activeWorkerId: "turn-worker-a",
    });

    expect(chatAgent.run).not.toHaveBeenCalled();
    expect(
      composeRepository.completeTurnWithAssistantMessage,
    ).toHaveBeenCalledTimes(2);
    expect(composeRepository.markTurnJobFailed).not.toHaveBeenCalled();
  });

  it("postMessage can answer through the coordinator without running the legacy chat agent", async () => {
    const chatCoordinator = {
      decide: vi.fn().mockResolvedValue({
        action: "answer",
        answer: "Retry handling is implemented in compose-database.ts.",
        confidence: "high",
        contextVersionUsed: 4,
      }),
    };
    const { service, composeRepository, chatAgent, workspaceManager, sseHub } =
      buildService({ chatCoordinator });
    composeRepository.getSession.mockResolvedValue(
      sessionSummary({
        id: 7,
        workspacePath: "/w/7",
        claudeSessionId: "sess-1",
        latestContextVersion: 4,
      }),
    );

    await service.postMessage({
      sessionId: 7,
      content: "Where is retry implemented?",
    });
    await flushAsyncTurns();

    expect(chatCoordinator.decide).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 7,
        userMessage: "Where is retry implemented?",
        requestedContextVersion: 4,
        contextVersionUsed: 4,
      }),
    );
    expect(chatAgent.run).not.toHaveBeenCalled();
    expect(workspaceManager.prepare).not.toHaveBeenCalled();
    expect(
      composeRepository.appendAssistantMessageIfSessionActive,
    ).toHaveBeenCalledWith({
      sessionId: 7,
      content: "Retry handling is implemented in compose-database.ts.",
      contextVersionUsed: 4,
    });
    expect(composeRepository.setReadiness).not.toHaveBeenCalled();
    expect(sseHub.publish).toHaveBeenCalledWith(7, {
      type: "message",
      role: "assistant",
      content: "Retry handling is implemented in compose-database.ts.",
    });
    expect(sseHub.publish).toHaveBeenCalledWith(7, {
      type: "status",
      status: "idle",
    });
  });

  it("persists grounded module, repository, and estimate metadata from coordinator answers", async () => {
    const chatCoordinator = {
      decide: vi.fn().mockResolvedValue({
        action: "answer",
        answer: "CPSR-1100 describes the P32Health change.",
        confidence: "high",
        details: {
          module: "P32Health",
          repositories: ["cp-medhok-monorepo"],
          difficulty: "M",
          storyPoints: 8,
        },
      }),
    };
    const { service, composeRepository, sseHub } = buildService({
      chatCoordinator,
    });
    composeRepository.getSession.mockResolvedValue(
      sessionSummary({ latestContextVersion: 4 }),
    );
    composeRepository.listSessionSources.mockResolvedValue([
      {
        id: 206,
        sessionId: 7,
        kind: "jira",
        originalFilename: "CPSR-1100",
        conversionStatus: "converted",
        markdownContent: "# CPSR-1100\n\nP32Health LOE request",
        sourceEntities: {
          jiraKeys: ["CPSR-1100"],
          repositories: ["cp-medhok-monorepo"],
          files: [],
          clients: [],
          loeHours: [60],
          dates: [],
          assumptions: [],
        },
      },
    ]);

    await service.postMessage({
      sessionId: 7,
      content: "Check the Jira ticket and summarize it.",
    });
    await flushAsyncTurns();

    expect(composeRepository.setReadiness).toHaveBeenCalledWith({
      sessionId: 7,
      readiness: {
        ready: false,
        openQuestions: [],
        summary: "",
        details: {
          module: "P32Health",
          repositories: ["cp-medhok-monorepo"],
          difficulty: "M",
          loeHours: 60,
          storyPoints: 8,
        },
      },
    });
    expect(sseHub.publish).toHaveBeenCalledWith(7, {
      type: "invalidate",
      resource: "readiness",
    });
  });

  it("postMessage can route coordinator decisions through the chat_coordination executor seam", async () => {
    const chatCoordinator = {
      decide: vi.fn(),
    };
    const chatCoordinationExecutor = {
      execute: vi.fn().mockResolvedValue({
        action: "answer",
        answer: "Context v4 is enough.",
        confidence: "high",
        contextVersionUsed: 4,
      }),
    };
    const metrics = { recordCoordinatorRoute: vi.fn() };
    const { service, chatAgent } = buildService({
      chatCoordinator,
      chatCoordinationExecutor,
      metrics,
    });

    await service.postMessage({
      sessionId: 7,
      content: "Can we answer now?",
    });
    await flushAsyncTurns();

    expect(chatCoordinationExecutor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 7,
        userMessage: "Can we answer now?",
      }),
    );
    expect(chatCoordinator.decide).not.toHaveBeenCalled();
    expect(chatAgent.run).not.toHaveBeenCalled();
    expect(metrics.recordCoordinatorRoute).toHaveBeenCalledWith({
      action: "answer",
      outcome: "selected",
      durationMs: expect.any(Number),
      reason: undefined,
    });
  });

  it("postMessage fences coordinator answers through the durable turn final write", async () => {
    const chatCoordinator = {
      decide: vi.fn().mockResolvedValue({
        action: "answer",
        answer: "Use the turn ledger.",
        confidence: "medium",
        contextVersionUsed: 99,
      }),
    };
    const { service, composeRepository, chatAgent } = buildService({
      chatCoordinator,
    });
    composeRepository.getSession.mockResolvedValue(
      sessionSummary({ latestContextVersion: 4 }),
    );

    await service.postMessage({
      sessionId: 7,
      content: "Where is the ledger?",
      idempotencyKey: "msg-ledger",
    });
    await flushAsyncTurns();

    expect(chatAgent.run).not.toHaveBeenCalled();
    expect(
      composeRepository.completeTurnWithAssistantMessage,
    ).toHaveBeenCalledWith({
      turnJobId: 101,
      sessionId: 7,
      content: "Use the turn ledger.",
      contextVersionUsed: 4,
      finalPayload: {
        action: "answer",
        answer: "Use the turn ledger.",
        confidence: "medium",
        contextVersionUsed: 99,
      },
      lease: {
        workerId: "legacy-compose-service",
        leaseGeneration: 1,
      },
    });
    expect(
      composeRepository.appendAssistantMessageIfSessionActive,
    ).not.toHaveBeenCalled();
  });

  it("postMessage enqueues critic review for durable coordinator answers when enabled", async () => {
    vi.stubEnv("SPEC_FACTORY_ENABLE_CRITIC", "true");
    vi.stubEnv("SPEC_FACTORY_LLM_GATEWAY", "true");
    const chatCoordinator = {
      decide: vi.fn().mockResolvedValue({
        action: "answer",
        answer: "Use the turn ledger.",
        confidence: "medium",
      }),
    };
    const { service, composeRepository } = buildService({
      chatCoordinator,
    });
    composeRepository.getSession.mockResolvedValue(
      sessionSummary({ latestContextVersion: 4 }),
    );

    await service.postMessage({
      sessionId: 7,
      content: "Where is the ledger?",
      idempotencyKey: "msg-ledger",
    });
    await flushAsyncTurns();

    expect(composeRepository.createAgentTask).toHaveBeenCalledWith({
      sessionId: 7,
      turnJobId: 101,
      capability: "critic_review",
      executorType: "critic_review",
      priority: 40,
      maxAttempts: 1,
      outputSourceId: null,
      input: expect.objectContaining({
        userMessage: "Where is the ledger?",
        answer: "Use the turn ledger.",
        contextVersionUsed: 4,
        generatedResearch: [],
      }),
    });
    expect(composeRepository.appendSessionEvent).toHaveBeenCalledWith({
      sessionId: 7,
      eventType: "task.queued",
      payload: {
        capability: "critic_review",
        executorType: "critic_review",
        contextVersionUsed: 4,
      },
      actorType: "system",
      actorId: "critic_scheduler",
      turnJobId: 101,
      agentTaskId: 501,
      contextVersion: 4,
    });
  });

  it("postMessage falls back to the legacy chat agent for non-answer coordinator decisions", async () => {
    const chatCoordinator = {
      decide: vi.fn().mockResolvedValue({
        action: "ask_clarification",
        question: "Which repository should I inspect?",
        reason: "The session has no selected repository.",
        expiresAt: "2026-06-18T01:00:00.000Z",
      }),
    };
    const { service, composeRepository, chatAgent } = buildService({
      chatCoordinator,
    });
    chatAgent.run.mockResolvedValue({
      envelope: {
        reply: "Which repository should I inspect?",
        readiness: {
          ready: false,
          openQuestions: ["Which repository?"],
          summary: "Need repository selection.",
        },
      },
      sessionId: "sess-1",
      metrics: {},
    });

    await service.postMessage({
      sessionId: 7,
      content: "Where is retry implemented?",
    });
    await flushAsyncTurns();

    expect(chatCoordinator.decide).toHaveBeenCalled();
    expect(chatAgent.run).toHaveBeenCalledTimes(1);
    expect(
      composeRepository.appendAssistantMessageIfSessionActive,
    ).toHaveBeenCalledWith({
      sessionId: 7,
      content: "Which repository should I inspect?",
      contextVersionUsed: null,
    });
  });

  it("postMessage completes coordinator escalation without running the legacy chat agent", async () => {
    const chatCoordinator = {
      decide: vi.fn().mockResolvedValue({
        action: "escalate",
        reason: "The session has no evidence for the requested claim.",
      }),
    };
    const { service, composeRepository, chatAgent, sseHub } = buildService({
      chatCoordinator,
    });
    composeRepository.getSession.mockResolvedValue(
      sessionSummary({ latestContextVersion: 4 }),
    );

    await service.postMessage({
      sessionId: 7,
      content: "Can you make up the implementation detail?",
    });
    await flushAsyncTurns();

    const escalationMessage =
      "I can't answer safely with the current context/tools: The session has no evidence for the requested claim.";
    expect(chatAgent.run).not.toHaveBeenCalled();
    expect(
      composeRepository.appendAssistantMessageIfSessionActive,
    ).toHaveBeenCalledWith({
      sessionId: 7,
      content: escalationMessage,
      contextVersionUsed: 4,
    });
    expect(composeRepository.appendSessionEvent).toHaveBeenCalledWith({
      sessionId: 7,
      eventType: "policy_denied",
      payload: {
        action: "escalate",
        reason: "The session has no evidence for the requested claim.",
      },
      actorType: "system",
      actorId: "chat_coordinator",
      turnJobId: null,
      contextVersion: 4,
    });
    expect(sseHub.publish).toHaveBeenCalledWith(7, {
      type: "message",
      role: "assistant",
      content: escalationMessage,
    });
    expect(sseHub.publish).toHaveBeenCalledWith(7, {
      type: "status",
      status: "idle",
    });
  });

  it("postMessage enqueues critic review for legacy assistant answers when enabled", async () => {
    vi.stubEnv("SPEC_FACTORY_ENABLE_CRITIC", "true");
    vi.stubEnv("SPEC_FACTORY_LLM_GATEWAY", "true");
    const { service, composeRepository, chatAgent } = buildService();
    chatAgent.run.mockResolvedValue({
      envelope: {
        reply: "Use compose-database.ts.",
        readiness: { ready: true, openQuestions: [], summary: "ready" },
        contextMarkdown: "# Context\n\nLedger evidence.",
      },
      sessionId: "sess-1",
      metrics: {},
    });

    await service.postMessage({
      sessionId: 7,
      content: "Where is the ledger?",
    });
    await flushAsyncTurns();

    expect(composeRepository.createAgentTask).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 7,
        turnJobId: null,
        capability: "critic_review",
        executorType: "critic_review",
        input: expect.objectContaining({
          userMessage: "Where is the ledger?",
          answer: "Use compose-database.ts.",
          workingContextMarkdown: "# Context\n\nLedger evidence.",
          contextVersionUsed: null,
        }),
      }),
    );
  });

  it("postMessage parks durable turns when the coordinator asks for clarification", async () => {
    const chatCoordinator = {
      decide: vi.fn().mockResolvedValue({
        action: "ask_clarification",
        question: "Which repository should I inspect?",
        reason: "The session has no selected repository.",
        expiresAt: "2026-06-18T01:00:00.000Z",
      }),
    };
    const { service, composeRepository, chatAgent, sseHub } = buildService({
      chatCoordinator,
    });
    composeRepository.getSession.mockResolvedValue(
      sessionSummary({ latestContextVersion: 4 }),
    );

    await service.postMessage({
      sessionId: 7,
      content: "Where is retry implemented?",
      idempotencyKey: "msg-clarify",
    });
    await flushAsyncTurns();

    expect(chatAgent.run).not.toHaveBeenCalled();
    expect(composeRepository.parkTurnForClarification).toHaveBeenCalledWith({
      sessionId: 7,
      turnJobId: 101,
      lease: {
        workerId: "legacy-compose-service",
        leaseGeneration: 1,
      },
      question: "Which repository should I inspect?",
      reason: "The session has no selected repository.",
      expiresAt: new Date("2026-06-18T01:00:00.000Z"),
      contextVersionUsed: 4,
    });
    expect(
      composeRepository.completeTurnWithAssistantMessage,
    ).not.toHaveBeenCalled();
    expect(composeRepository.appendSessionEvent).toHaveBeenCalledWith({
      sessionId: 7,
      eventType: "turn.awaiting_user_input",
      payload: {
        question: "Which repository should I inspect?",
        reason: "The session has no selected repository.",
        expiresAt: "2026-06-18T01:00:00.000Z",
      },
      actorType: "system",
      actorId: "chat_coordinator",
      turnJobId: 101,
      contextVersion: 4,
    });
    expect(sseHub.publish).toHaveBeenCalledWith(7, {
      type: "message",
      role: "assistant",
      content: "Which repository should I inspect?",
    });
    expect(sseHub.publish).toHaveBeenCalledWith(7, {
      type: "status",
      status: "idle",
    });
  });

  it("postMessage answers an awaiting clarification by requeueing the parked turn", async () => {
    const { service, composeRepository, chatAgent, sseHub } = buildService();
    composeRepository.answerAwaitingClarification.mockResolvedValueOnce({
      answered: true,
      turnJobId: 101,
      messageId: 61,
      status: "queued",
      userMessageId: 51,
      deduplicated: false,
    });
    composeRepository.listMessages.mockResolvedValue([
      {
        id: 51,
        sessionId: 7,
        role: "user",
        content: "Where is retry implemented?",
        createdAt: "2026-06-02T00:00:00.000Z",
      },
      {
        id: 61,
        sessionId: 7,
        role: "user",
        content: "billing-service",
        createdAt: "2026-06-02T00:01:00.000Z",
      },
    ]);
    chatAgent.run.mockResolvedValueOnce({
      envelope: {
        reply: "Retry handling is in compose-database.ts.",
        readiness: { ready: true, openQuestions: [], summary: "ready" },
      },
      sessionId: "sess-1",
      metrics: {},
    });

    const result = await service.postMessage({
      sessionId: 7,
      content: "billing-service",
      idempotencyKey: "clar-answer-1",
    });
    await flushAsyncTurns();

    expect(result).toEqual({
      accepted: true,
      messageId: 61,
      turnJobId: 101,
      status: "queued",
    });
    expect(composeRepository.createMessageTurn).not.toHaveBeenCalled();
    expect(composeRepository.appendMessage).not.toHaveBeenCalled();
    expect(composeRepository.answerAwaitingClarification).toHaveBeenCalledWith({
      sessionId: 7,
      content: "billing-service",
      idempotencyKey: "clar-answer-1",
    });
    expect(chatAgent.run).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "chat",
        latestUserMessage: "Where is retry implemented?",
      }),
    );
    expect(sseHub.publish).toHaveBeenCalledWith(7, {
      type: "message",
      role: "user",
      content: "billing-service",
    });
    expect(composeRepository.appendSessionEvent).toHaveBeenCalledWith({
      sessionId: 7,
      eventType: "turn.clarification_answered",
      payload: {
        messageId: 61,
      },
      actorType: "system",
      actorId: "chat_coordinator",
      turnJobId: 101,
    });
  });

  it("postMessage records expired clarification before creating a fresh durable turn", async () =>
    withDurableTurnsMode("drain", async () => {
      const { service, composeRepository, chatAgent } = buildService();
      composeRepository.answerAwaitingClarification.mockResolvedValueOnce({
        answered: false,
        expiredTurnId: 101,
      });

      const result = await service.postMessage({
        sessionId: 7,
        content: "billing-service",
        idempotencyKey: "msg-after-expiry",
      });
      await flushAsyncTurns();

      expect(result).toEqual({
        accepted: true,
        messageId: 51,
        turnJobId: 101,
        status: "queued",
      });
      expect(composeRepository.createMessageTurn).toHaveBeenCalledWith({
        sessionId: 7,
        content: "billing-service",
        idempotencyKey: "msg-after-expiry",
        requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(composeRepository.appendSessionEvent).toHaveBeenCalledWith({
        sessionId: 7,
        eventType: "turn.clarification_expired",
        payload: {
          turnJobId: 101,
        },
        actorType: "system",
        actorId: "chat_coordinator",
        turnJobId: 101,
      });
      expect(chatAgent.run).not.toHaveBeenCalled();
    }));

  it("postMessage falls back to legacy when coordinator research lacks a durable worker", async () => {
    vi.stubEnv("SPEC_FACTORY_RESEARCH_EXECUTOR", "claude_agent_sdk");
    const chatCoordinator = {
      decide: vi.fn().mockResolvedValue({
        action: "dispatch_research",
        userVisibleStatus: "Checking implementation details",
        synthesisInstructions: "Summarize with file evidence.",
        researchTasks: [
          {
            capability: "code_research",
            question: "Where is retry implemented?",
            requiredEvidence: true,
            maxCostUsd: 1.25,
          },
        ],
      }),
    };
    const { service, composeRepository, chatAgent, sseHub } = buildService({
      chatCoordinator,
    });
    composeRepository.getSession.mockResolvedValue(
      sessionSummary({ latestContextVersion: 4 }),
    );
    chatAgent.run.mockResolvedValue({
      envelope: {
        reply: "Legacy fallback until durable turns are on.",
        readiness: { ready: true, openQuestions: [], summary: "ready" },
      },
      sessionId: "sess-1",
      metrics: {},
    });

    await service.postMessage({
      sessionId: 7,
      content: "Where is retry implemented?",
    });
    await flushAsyncTurns();

    expect(composeRepository.createAgentTask).not.toHaveBeenCalled();
    expect(composeRepository.parkTurnForResearch).not.toHaveBeenCalled();
    expect(chatAgent.run).toHaveBeenCalledTimes(1);
    expect(
      composeRepository.appendAssistantMessageIfSessionActive,
    ).toHaveBeenCalledWith({
      sessionId: 7,
      content: "Legacy fallback until durable turns are on.",
      contextVersionUsed: null,
    });
    expect(sseHub.publish).not.toHaveBeenCalledWith(7, {
      type: "status",
      status: "thinking",
      mode: "chat",
      message: "Checking implementation details",
    });
  });

  it("executeClaimedTurn completes durable coordinator escalation as a fenced final response", async () => {
    const chatCoordinator = {
      decide: vi.fn().mockResolvedValue({
        action: "escalate",
        reason: "The available context cannot answer the request safely.",
      }),
    };
    const { service, composeRepository, chatAgent, sseHub } = buildService({
      chatCoordinator,
    });
    composeRepository.getSession.mockResolvedValue(
      sessionSummary({ latestContextVersion: 4 }),
    );
    composeRepository.listMessages.mockResolvedValue([
      {
        id: 51,
        sessionId: 7,
        role: "user",
        content: "Should we promise this is already implemented?",
        createdAt: "2026-06-02T00:00:00.000Z",
      },
    ]);

    await service.executeClaimedTurn({
      id: 101,
      sessionId: 7,
      turnKind: "chat",
      userMessageId: 51,
      status: "running",
      leaseGeneration: 1,
      activeWorkerId: "turn-worker-a",
    });

    const escalationMessage =
      "I can't answer safely with the current context/tools: The available context cannot answer the request safely.";
    expect(chatAgent.run).not.toHaveBeenCalled();
    expect(
      composeRepository.completeTurnWithAssistantMessage,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        turnJobId: 101,
        sessionId: 7,
        content: escalationMessage,
        contextVersionUsed: 4,
        finalPayload: {
          action: "escalate",
          reason: "The available context cannot answer the request safely.",
        },
        lease: {
          workerId: "turn-worker-a",
          leaseGeneration: 1,
        },
      }),
    );
    expect(composeRepository.appendSessionEvent).toHaveBeenCalledWith({
      sessionId: 7,
      eventType: "policy_denied",
      payload: {
        action: "escalate",
        reason: "The available context cannot answer the request safely.",
      },
      actorType: "system",
      actorId: "chat_coordinator",
      turnJobId: 101,
      contextVersion: 4,
    });
    expect(composeRepository.appendSessionEvent).toHaveBeenCalledWith({
      sessionId: 7,
      eventType: "turn.completed",
      payload: {
        turnJobId: 101,
        turnKind: "chat",
        assistantMessageId: 52,
        coordinatorAction: "escalate",
      },
      actorType: "system",
      actorId: "turn-worker-a",
      turnJobId: 101,
    });
    expect(sseHub.publish).toHaveBeenCalledWith(7, {
      type: "message",
      role: "assistant",
      content: escalationMessage,
    });
  });

  it("executeClaimedTurn parks durable turns when the coordinator dispatches config research", async () => {
    vi.stubEnv("SPEC_FACTORY_RESEARCH_EXECUTOR", "claude_agent_sdk");
    vi.stubEnv("SPEC_FACTORY_DURABLE_TURNS", "on");
    vi.stubEnv("SPEC_FACTORY_RESEARCH_COST_CEILING_USD", "10");
    const chatCoordinator = {
      decide: vi.fn().mockResolvedValue({
        action: "dispatch_research",
        userVisibleStatus: "Checking configuration",
        synthesisInstructions: "Summarize findings.",
        researchTasks: [
          {
            capability: "config_research",
            question: "Which flag enables it?",
            requiredEvidence: true,
            maxCostUsd: 1,
          },
        ],
      }),
    };
    const { service, composeRepository, chatAgent } = buildService({
      chatCoordinator,
    });
    composeRepository.getSession.mockResolvedValue(
      sessionSummary({ latestContextVersion: 4 }),
    );
    composeRepository.listMessages.mockResolvedValue([
      {
        id: 51,
        sessionId: 7,
        role: "user",
        content: "Which flag enables it?",
        createdAt: "2026-06-02T00:00:00.000Z",
      },
    ]);

    await service.executeClaimedTurn({
      id: 101,
      sessionId: 7,
      turnKind: "chat",
      userMessageId: 51,
      status: "running",
      leaseGeneration: 1,
      activeWorkerId: "turn-worker-a",
    });
    await flushAsyncTurns();

    expect(chatAgent.run).not.toHaveBeenCalled();
    expect(composeRepository.createAgentTask).not.toHaveBeenCalled();
    expect(composeRepository.parkTurnForResearch).toHaveBeenCalledWith({
      sessionId: 7,
      turnJobId: 101,
      lease: {
        workerId: "turn-worker-a",
        leaseGeneration: 1,
      },
      tasks: [
        {
          capability: "config_research",
          executorType: "code_research",
          priority: 70,
          maxAttempts: 2,
          outputSourceId: null,
          input: {
            question: "Which flag enables it?",
            parentSourceIds: [],
            contextVersionUsed: 4,
            requiredEvidence: true,
            maxCostUsd: 1,
            synthesisInstructions: "Summarize findings.",
          },
        },
      ],
    });
  });

  it("postMessage parks durable turns when the coordinator dispatches code research", async () => {
    vi.stubEnv("SPEC_FACTORY_RESEARCH_EXECUTOR", "claude_agent_sdk");
    vi.stubEnv("SPEC_FACTORY_DURABLE_TURNS", "on");
    vi.stubEnv("SPEC_FACTORY_RESEARCH_COST_CEILING_USD", "10");
    const chatCoordinator = {
      decide: vi.fn().mockResolvedValue({
        action: "dispatch_research",
        userVisibleStatus: "Checking code",
        synthesisInstructions: "Summarize findings.",
        researchTasks: [
          {
            capability: "code_research",
            question: "Where is retry implemented?",
            requiredEvidence: true,
            maxCostUsd: 1,
          },
        ],
      }),
    };
    const { service, composeRepository, chatAgent } = buildService({
      chatCoordinator,
    });
    composeRepository.getSession.mockResolvedValue(
      sessionSummary({ latestContextVersion: 4 }),
    );
    composeRepository.listMessages.mockResolvedValue([
      {
        id: 51,
        sessionId: 7,
        role: "user",
        content: "Where is retry implemented?",
        createdAt: "2026-06-02T00:00:00.000Z",
      },
    ]);

    await service.executeClaimedTurn({
      id: 101,
      sessionId: 7,
      turnKind: "chat",
      userMessageId: 51,
      status: "running",
      leaseGeneration: 1,
      activeWorkerId: "turn-worker-a",
    });
    await flushAsyncTurns();

    expect(chatAgent.run).not.toHaveBeenCalled();
    expect(composeRepository.createAgentTask).not.toHaveBeenCalled();
    expect(composeRepository.parkTurnForResearch).toHaveBeenCalledWith({
      sessionId: 7,
      turnJobId: 101,
      lease: {
        workerId: "turn-worker-a",
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
            parentSourceIds: [],
            contextVersionUsed: 4,
            requiredEvidence: true,
            maxCostUsd: 1,
            synthesisInstructions: "Summarize findings.",
          },
        },
      ],
    });
    expect(
      composeRepository.completeTurnWithAssistantMessage,
    ).not.toHaveBeenCalled();
  });

  it("executeClaimedTurn caps coordinator research task cost at the configured per-task budget", async () => {
    vi.stubEnv("SPEC_FACTORY_RESEARCH_EXECUTOR", "claude_agent_sdk");
    vi.stubEnv("SPEC_FACTORY_DURABLE_TURNS", "on");
    vi.stubEnv("SPEC_FACTORY_RESEARCH_COST_CEILING_USD", "5");
    vi.stubEnv("SPEC_FACTORY_RESEARCH_MAX_COST_USD", "2");
    const chatCoordinator = {
      decide: vi.fn().mockResolvedValue({
        action: "dispatch_research",
        userVisibleStatus: "Checking code",
        synthesisInstructions: "Summarize findings.",
        researchTasks: [
          {
            capability: "code_research",
            question: "Where is retry implemented?",
            requiredEvidence: true,
            maxCostUsd: 10,
          },
        ],
      }),
    };
    const { service, composeRepository, chatAgent } = buildService({
      chatCoordinator,
    });
    composeRepository.getSession.mockResolvedValue(
      sessionSummary({ latestContextVersion: 4 }),
    );
    composeRepository.listMessages.mockResolvedValue([
      {
        id: 51,
        sessionId: 7,
        role: "user",
        content: "Where is retry implemented?",
        createdAt: "2026-06-02T00:00:00.000Z",
      },
    ]);

    await service.executeClaimedTurn({
      id: 101,
      sessionId: 7,
      turnKind: "chat",
      userMessageId: 51,
      status: "running",
      leaseGeneration: 1,
      activeWorkerId: "turn-worker-a",
    });
    await flushAsyncTurns();

    expect(chatAgent.run).not.toHaveBeenCalled();
    expect(composeRepository.parkTurnForResearch).toHaveBeenCalledWith(
      expect.objectContaining({
        tasks: [
          expect.objectContaining({
            input: expect.objectContaining({
              maxCostUsd: 2,
            }),
          }),
        ],
      }),
    );
    expect(composeRepository.appendSessionEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "coordinator.decision.rejected",
      }),
    );
  });

  it("executeClaimedTurn rejects coordinator research when the session budget would be exceeded", async () => {
    vi.stubEnv("SPEC_FACTORY_RESEARCH_EXECUTOR", "claude_agent_sdk");
    vi.stubEnv("SPEC_FACTORY_DURABLE_TURNS", "on");
    vi.stubEnv("SPEC_FACTORY_RESEARCH_COST_CEILING_USD", "1.50");
    const chatCoordinator = {
      decide: vi.fn().mockResolvedValue({
        action: "dispatch_research",
        userVisibleStatus: "Checking code",
        synthesisInstructions: "Summarize findings.",
        researchTasks: [
          {
            capability: "code_research",
            question: "Where is retry implemented?",
            requiredEvidence: true,
            maxCostUsd: 0.5,
          },
        ],
      }),
    };
    const { service, composeRepository, chatAgent, sseHub } = buildService({
      chatCoordinator,
    });
    composeRepository.getSession.mockResolvedValue(
      sessionSummary({ latestContextVersion: 4 }),
    );
    composeRepository.listMessages.mockResolvedValue([
      {
        id: 51,
        sessionId: 7,
        role: "user",
        content: "Where is retry implemented?",
        createdAt: "2026-06-02T00:00:00.000Z",
      },
    ]);
    composeRepository.getSessionResearchBudgetUsage.mockResolvedValueOnce({
      spentCostUsd: 0.75,
      reservedCostUsd: 0.5,
      researchTasks24h: 0,
      inFlightTasks: 0,
    });
    chatAgent.run.mockResolvedValue({
      envelope: {
        reply: "Legacy fallback after budget rejection.",
        readiness: { ready: true, openQuestions: [], summary: "ready" },
      },
      sessionId: "sess-1",
      metrics: {},
    });

    await service.executeClaimedTurn({
      id: 101,
      sessionId: 7,
      turnKind: "chat",
      userMessageId: 51,
      status: "running",
      leaseGeneration: 1,
      activeWorkerId: "turn-worker-a",
    });

    expect(composeRepository.parkTurnForResearch).not.toHaveBeenCalled();
    expect(composeRepository.appendSessionEvent).toHaveBeenCalledWith({
      sessionId: 7,
      eventType: "coordinator.decision.rejected",
      payload: {
        reason: "budget_exceeded",
        message: "coordinator_decision_rejected:budget_exceeded",
      },
      actorType: "system",
      actorId: "chat_coordinator",
      turnJobId: 101,
      contextVersion: 4,
    });
    expect(sseHub.publish).not.toHaveBeenCalledWith(7, {
      type: "status",
      status: "thinking",
      mode: "chat",
      message: "Checking code",
    });
    expect(chatAgent.run).toHaveBeenCalledTimes(1);
  });

  it("executeClaimedTurn rejects coordinator research when the global budget would be exceeded", async () => {
    vi.stubEnv("SPEC_FACTORY_RESEARCH_EXECUTOR", "claude_agent_sdk");
    vi.stubEnv("SPEC_FACTORY_DURABLE_TURNS", "on");
    vi.stubEnv("SPEC_FACTORY_RESEARCH_COST_CEILING_USD", "10");
    vi.stubEnv("SPEC_FACTORY_RESEARCH_GLOBAL_COST_CEILING_USD", "2.00");
    const chatCoordinator = {
      decide: vi.fn().mockResolvedValue({
        action: "dispatch_research",
        userVisibleStatus: "Checking code",
        synthesisInstructions: "Summarize findings.",
        researchTasks: [
          {
            capability: "code_research",
            question: "Where is retry implemented?",
            requiredEvidence: true,
            maxCostUsd: 0.75,
          },
        ],
      }),
    };
    const { service, composeRepository, chatAgent } = buildService({
      chatCoordinator,
    });
    composeRepository.getSession.mockResolvedValue(
      sessionSummary({ latestContextVersion: 4 }),
    );
    composeRepository.listMessages.mockResolvedValue([
      {
        id: 51,
        sessionId: 7,
        role: "user",
        content: "Where is retry implemented?",
        createdAt: "2026-06-02T00:00:00.000Z",
      },
    ]);
    composeRepository.getGlobalResearchBudgetUsage.mockResolvedValueOnce({
      spentCostUsd: 1.25,
      reservedCostUsd: 0.25,
      researchTasks24h: 0,
      inFlightTasks: 0,
    });
    chatAgent.run.mockResolvedValue({
      envelope: {
        reply: "Legacy fallback after global budget rejection.",
        readiness: { ready: true, openQuestions: [], summary: "ready" },
      },
      sessionId: "sess-1",
      metrics: {},
    });

    await service.executeClaimedTurn({
      id: 101,
      sessionId: 7,
      turnKind: "chat",
      userMessageId: 51,
      status: "running",
      leaseGeneration: 1,
      activeWorkerId: "turn-worker-a",
    });

    expect(composeRepository.getGlobalResearchBudgetUsage).toHaveBeenCalled();
    expect(composeRepository.parkTurnForResearch).not.toHaveBeenCalled();
    expect(composeRepository.appendSessionEvent).toHaveBeenCalledWith({
      sessionId: 7,
      eventType: "coordinator.decision.rejected",
      payload: {
        reason: "global_budget_exceeded",
        message: "coordinator_decision_rejected:global_budget_exceeded",
      },
      actorType: "system",
      actorId: "chat_coordinator",
      turnJobId: 101,
      contextVersion: 4,
    });
    expect(chatAgent.run).toHaveBeenCalledTimes(1);
  });

  it("postMessage records coordinator decision rejections before falling back", async () => {
    const chatCoordinator = {
      decide: vi
        .fn()
        .mockRejectedValue(
          new Error("coordinator_decision_rejected:max_research_tasks"),
        ),
    };
    const metrics = { recordCoordinatorRoute: vi.fn() };
    const { service, composeRepository, chatAgent } = buildService({
      chatCoordinator,
      metrics,
    });
    chatAgent.run.mockResolvedValue({
      envelope: {
        reply: "Legacy fallback.",
        readiness: { ready: true, openQuestions: [], summary: "ready" },
      },
      sessionId: "sess-1",
      metrics: {},
    });

    await service.postMessage({
      sessionId: 7,
      content: "Research all the things",
    });
    await flushAsyncTurns();

    expect(composeRepository.appendSessionEvent).toHaveBeenCalledWith({
      sessionId: 7,
      eventType: "coordinator.decision.rejected",
      payload: {
        reason: "max_research_tasks",
        message: "coordinator_decision_rejected:max_research_tasks",
      },
      actorType: "system",
      actorId: "chat_coordinator",
      turnJobId: null,
      contextVersion: null,
    });
    expect(chatAgent.run).toHaveBeenCalledTimes(1);
    expect(metrics.recordCoordinatorRoute).toHaveBeenCalledWith({
      action: undefined,
      outcome: "rejected",
      durationMs: expect.any(Number),
      reason: "decision_rejected",
    });
  });

  it("fails closed instead of invoking legacy chat when legacy runtime is disabled", async () => {
    vi.stubEnv("SPEC_FACTORY_LEGACY_RUNTIME", "disabled");
    const chatCoordinator = {
      decide: vi
        .fn()
        .mockRejectedValue(new Error("coordinator_provider_unavailable")),
    };
    const { service, composeRepository, chatAgent } = buildService({
      chatCoordinator,
    });
    composeRepository.listMessages.mockResolvedValue([
      {
        id: 51,
        sessionId: 7,
        role: "user",
        content: "Summarize the pending work",
        createdAt: "2026-07-10T00:00:00.000Z",
      },
    ]);

    await expect(
      service.executeClaimedTurn({
        id: 101,
        sessionId: 7,
        turnKind: "chat",
        userMessageId: 51,
        status: "running",
        leaseGeneration: 1,
        activeWorkerId: "turn-worker-a",
      }),
    ).rejects.toThrow("coordinator_required:coordinator_provider_unavailable");

    expect(chatCoordinator.decide).toHaveBeenCalledTimes(1);
    expect(chatAgent.run).not.toHaveBeenCalled();
    expect(
      composeRepository.completeTurnWithAssistantMessage,
    ).not.toHaveBeenCalled();
  });

  it("postMessage does not fall back to legacy after a coordinator answer final-write failure", async () => {
    const chatCoordinator = {
      decide: vi.fn().mockResolvedValue({
        action: "answer",
        answer: "Use the turn ledger.",
        confidence: "high",
        contextVersionUsed: 4,
      }),
    };
    const { service, composeRepository, chatAgent, sseHub } = buildService({
      chatCoordinator,
    });
    composeRepository.appendAssistantMessageIfSessionActive.mockRejectedValueOnce(
      new Error("db write failed"),
    );
    chatAgent.run.mockResolvedValue({
      envelope: {
        reply: "Legacy answer",
        readiness: { ready: true, openQuestions: [], summary: "ready" },
      },
      sessionId: "sess-1",
      metrics: {},
    });

    await service.postMessage({
      sessionId: 7,
      content: "Where is retry implemented?",
    });
    await flushAsyncTurns();

    expect(chatCoordinator.decide).toHaveBeenCalled();
    expect(chatAgent.run).not.toHaveBeenCalled();
    expect(sseHub.publish).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        type: "status",
        status: "error",
        message: "db write failed",
      }),
    );
  });

  it("postMessage accepts the user turn without waiting for the assistant response", async () => {
    const { service, chatAgent, composeRepository } = buildService();
    chatAgent.run.mockReturnValue(new Promise(() => undefined));

    const result = await Promise.race([
      service.postMessage({ sessionId: 7, content: "billing-service" }),
      new Promise((resolve) => setTimeout(() => resolve("still-waiting"), 25)),
    ]);

    expect(result).toEqual({ accepted: true });
    expect(composeRepository.appendMessage).toHaveBeenCalledWith({
      sessionId: 7,
      role: "user",
      content: "billing-service",
    });
    await flushAsyncTurns(2);
    expect(chatAgent.run).toHaveBeenCalledTimes(1);
  });

  it("postMessage with an idempotency key creates the user message and turn atomically", async () => {
    const { service, composeRepository, chatAgent } = buildService();
    chatAgent.run.mockResolvedValue({
      envelope: {
        reply: "Ready",
        readiness: { ready: false, openQuestions: [], summary: "Needs more" },
      },
      sessionId: "claude-session",
      metrics: {},
    });

    const result = await service.postMessage({
      sessionId: 7,
      content: " billing-service ",
      actor: "kompallik",
      idempotencyKey: "msg-abc",
    });

    expect(composeRepository.createMessageTurn).toHaveBeenCalledWith({
      sessionId: 7,
      content: "billing-service",
      idempotencyKey: "msg-abc",
      requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(composeRepository.appendMessage).not.toHaveBeenCalledWith({
      sessionId: 7,
      role: "user",
      content: "billing-service",
    });
    expect(composeRepository.appendSessionEvent).toHaveBeenCalledWith({
      sessionId: 7,
      eventType: "turn.queued",
      payload: {
        turnJobId: 101,
        turnKind: "chat",
        userMessageId: 51,
        status: "queued",
      },
      actorType: "user",
      actorId: "kompallik",
      turnJobId: 101,
    });
    expect(result).toEqual({
      accepted: true,
      messageId: 51,
      turnJobId: 101,
      status: "queued",
    });
  });

  it("postMessage with a duplicate idempotency key does not publish or enqueue again", async () => {
    const { service, composeRepository, sseHub, chatAgent } = buildService();
    composeRepository.createMessageTurn.mockResolvedValueOnce({
      turnJobId: 101,
      messageId: 51,
      status: "queued",
      deduplicated: true,
    });

    const result = await service.postMessage({
      sessionId: 7,
      content: "billing-service",
      actor: "kompallik",
      idempotencyKey: "msg-abc",
    });

    expect(result).toEqual({
      accepted: true,
      messageId: 51,
      turnJobId: 101,
      status: "queued",
    });
    expect(sseHub.publish).not.toHaveBeenCalledWith(
      7,
      expect.objectContaining({ type: "message", role: "user" }),
    );
    expect(composeRepository.appendSessionEvent).toHaveBeenCalledWith({
      sessionId: 7,
      eventType: "turn.duplicate_suppressed",
      payload: {
        turnJobId: 101,
        turnKind: "chat",
        userMessageId: 51,
        status: "queued",
      },
      actorType: "user",
      actorId: "kompallik",
      turnJobId: 101,
    });
    expect(chatAgent.run).not.toHaveBeenCalled();
  });

  it("postMessage with an idempotency key stops before chat execution when no lease is established", async () => {
    const { service, composeRepository, chatAgent, sseHub } = buildService();
    composeRepository.markTurnJobRunning.mockResolvedValueOnce(null);

    const result = await service.postMessage({
      sessionId: 7,
      content: "billing-service",
      actor: "kompallik",
      idempotencyKey: "msg-abc",
    });
    await flushAsyncTurns();

    expect(result).toEqual({
      accepted: true,
      messageId: 51,
      turnJobId: 101,
      status: "queued",
    });
    expect(composeRepository.markTurnJobRunning).toHaveBeenCalledWith({
      turnJobId: 101,
      workerId: "legacy-compose-service",
      leaseUntil: expect.any(Date),
    });
    expect(chatAgent.run).not.toHaveBeenCalled();
    expect(
      composeRepository.completeTurnWithAssistantMessage,
    ).not.toHaveBeenCalled();
    expect(composeRepository.markTurnJobFailed).not.toHaveBeenCalled();
    expect(sseHub.publish).not.toHaveBeenCalledWith(
      7,
      expect.objectContaining({ type: "status", status: "error" }),
    );
  });

  it("postMessage with an idempotency key fences final writes on the active lease", async () => {
    const { service, composeRepository, chatAgent, sseHub } = buildService();
    composeRepository.confirmTurnLease
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    chatAgent.run.mockResolvedValue({
      envelope: {
        reply: "Ready",
        readiness: { ready: false, openQuestions: [], summary: "Needs more" },
      },
      sessionId: "claude-session",
      metrics: {},
    });

    await service.postMessage({
      sessionId: 7,
      content: "billing-service",
      actor: "kompallik",
      idempotencyKey: "msg-abc",
    });
    await flushAsyncTurns();

    expect(composeRepository.confirmTurnLease).toHaveBeenCalledWith({
      turnJobId: 101,
      workerId: "legacy-compose-service",
      leaseGeneration: 1,
    });
    expect(
      composeRepository.completeTurnWithAssistantMessage,
    ).not.toHaveBeenCalled();
    expect(composeRepository.markTurnJobFailed).not.toHaveBeenCalled();
    expect(sseHub.publish).not.toHaveBeenCalledWith(
      7,
      expect.objectContaining({ type: "message", role: "assistant" }),
    );
    expect(sseHub.publish).not.toHaveBeenCalledWith(
      7,
      expect.objectContaining({ type: "status", status: "error" }),
    );
  });

  it("postMessage with an idempotency key renews the active turn lease while the agent runs", async () => {
    const previousHeartbeat = process.env.SPEC_FACTORY_TURN_LEASE_HEARTBEAT_MS;
    process.env.SPEC_FACTORY_TURN_LEASE_HEARTBEAT_MS = "10";
    vi.useFakeTimers();
    try {
      const { service, composeRepository, chatAgent } = buildService();
      const run = deferred<{
        envelope: {
          reply: string;
          readiness: {
            ready: boolean;
            openQuestions: string[];
            summary: string;
          };
        };
        sessionId: string;
        metrics: Record<string, never>;
      }>();
      chatAgent.run.mockReturnValueOnce(run.promise);

      await service.postMessage({
        sessionId: 7,
        content: "billing-service",
        actor: "kompallik",
        idempotencyKey: "msg-abc",
      });
      await flushMicrotasks(20);

      await vi.advanceTimersByTimeAsync(10);

      expect(composeRepository.renewTurnLease).toHaveBeenCalledWith({
        turnJobId: 101,
        workerId: "legacy-compose-service",
        leaseGeneration: 1,
        leaseUntil: expect.any(Date),
      });

      run.resolve({
        envelope: {
          reply: "Ready",
          readiness: {
            ready: false,
            openQuestions: [],
            summary: "Needs more",
          },
        },
        sessionId: "claude-session",
        metrics: {},
      });
      await flushMicrotasks(20);
    } finally {
      vi.useRealTimers();
      if (previousHeartbeat === undefined) {
        delete process.env.SPEC_FACTORY_TURN_LEASE_HEARTBEAT_MS;
      } else {
        process.env.SPEC_FACTORY_TURN_LEASE_HEARTBEAT_MS = previousHeartbeat;
      }
    }
  });

  it("postMessage with an idempotency key stops after a failed lease renewal", async () => {
    const previousHeartbeat = process.env.SPEC_FACTORY_TURN_LEASE_HEARTBEAT_MS;
    process.env.SPEC_FACTORY_TURN_LEASE_HEARTBEAT_MS = "10";
    vi.useFakeTimers();
    try {
      const {
        service,
        composeRepository,
        chatAgent,
        workspaceManager,
        sseHub,
      } = buildService();
      composeRepository.renewTurnLease.mockResolvedValueOnce(false);
      const run = deferred<{
        envelope: {
          reply: string;
          readiness: {
            ready: boolean;
            openQuestions: string[];
            summary: string;
          };
        };
        sessionId: string;
        metrics: Record<string, never>;
      }>();
      chatAgent.run.mockReturnValueOnce(run.promise);

      await service.postMessage({
        sessionId: 7,
        content: "billing-service",
        actor: "kompallik",
        idempotencyKey: "msg-abc",
      });
      await flushMicrotasks(20);

      await vi.advanceTimersByTimeAsync(10);
      run.resolve({
        envelope: {
          reply: "Ready",
          readiness: {
            ready: false,
            openQuestions: [],
            summary: "Needs more",
          },
        },
        sessionId: "claude-session",
        metrics: {},
      });
      await flushMicrotasks(20);

      expect(
        composeRepository.completeTurnWithAssistantMessage,
      ).not.toHaveBeenCalled();
      expect(composeRepository.markTurnJobFailed).not.toHaveBeenCalled();
      expect(workspaceManager.prepare).toHaveBeenCalledTimes(1);
      expect(sseHub.publish).not.toHaveBeenCalledWith(
        7,
        expect.objectContaining({ type: "message", role: "assistant" }),
      );
      expect(sseHub.publish).not.toHaveBeenCalledWith(
        7,
        expect.objectContaining({ type: "status", status: "error" }),
      );
    } finally {
      vi.useRealTimers();
      if (previousHeartbeat === undefined) {
        delete process.env.SPEC_FACTORY_TURN_LEASE_HEARTBEAT_MS;
      } else {
        process.env.SPEC_FACTORY_TURN_LEASE_HEARTBEAT_MS = previousHeartbeat;
      }
    }
  });

  it("postMessage with an idempotency key stops when the final write loses its lease", async () => {
    const { service, composeRepository, chatAgent, workspaceManager, sseHub } =
      buildService();
    composeRepository.completeTurnWithAssistantMessage.mockResolvedValueOnce(
      null,
    );
    chatAgent.run.mockResolvedValue({
      envelope: {
        reply: "Ready",
        readiness: { ready: false, openQuestions: [], summary: "Needs more" },
      },
      sessionId: "claude-session",
      metrics: {},
    });

    await service.postMessage({
      sessionId: 7,
      content: "billing-service",
      actor: "kompallik",
      idempotencyKey: "msg-abc",
    });
    await flushAsyncTurns();

    expect(
      composeRepository.completeTurnWithAssistantMessage,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        turnJobId: 101,
        lease: {
          workerId: "legacy-compose-service",
          leaseGeneration: 1,
        },
      }),
    );
    expect(workspaceManager.prepare).toHaveBeenCalledTimes(1);
    expect(composeRepository.setReadiness).not.toHaveBeenCalled();
    expect(composeRepository.markTurnJobFailed).not.toHaveBeenCalled();
    expect(composeRepository.appendSessionEvent).toHaveBeenCalledWith({
      sessionId: 7,
      eventType: "turn.lease_fence_rejected",
      payload: {
        turnJobId: 101,
        turnKind: "chat",
        reason: "lease_lost",
      },
      actorType: "system",
      actorId: "legacy-compose-service",
      turnJobId: 101,
    });
    expect(sseHub.publish).not.toHaveBeenCalledWith(
      7,
      expect.objectContaining({ type: "message", role: "assistant" }),
    );
    expect(sseHub.publish).not.toHaveBeenCalledWith(
      7,
      expect.objectContaining({ type: "invalidate", resource: "readiness" }),
    );
    expect(sseHub.publish).not.toHaveBeenCalledWith(
      7,
      expect.objectContaining({ type: "status", status: "error" }),
    );
  });

  it("postMessage with an idempotency key discards the final response when archive wins the final transaction", async () => {
    const { service, composeRepository, chatAgent, workspaceManager, sseHub } =
      buildService();
    composeRepository.completeTurnWithAssistantMessage.mockResolvedValueOnce({
      assistantMessageId: null,
      deduplicated: false,
      discardedDueToArchive: true,
    });
    chatAgent.run.mockResolvedValue({
      envelope: {
        reply: "Ready",
        readiness: { ready: false, openQuestions: [], summary: "Needs more" },
      },
      sessionId: "claude-session",
      metrics: {},
    });

    await service.postMessage({
      sessionId: 7,
      content: "billing-service",
      actor: "kompallik",
      idempotencyKey: "msg-abc",
    });
    await flushAsyncTurns();

    expect(
      composeRepository.completeTurnWithAssistantMessage,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        turnJobId: 101,
        lease: {
          workerId: "legacy-compose-service",
          leaseGeneration: 1,
        },
      }),
    );
    expect(composeRepository.setClaudeSessionId).not.toHaveBeenCalled();
    expect(workspaceManager.prepare).toHaveBeenCalledTimes(1);
    expect(composeRepository.setReadiness).not.toHaveBeenCalled();
    expect(composeRepository.markTurnJobFailed).not.toHaveBeenCalled();
    expect(composeRepository.appendSessionEvent).toHaveBeenCalledWith({
      sessionId: 7,
      eventType: "turn.discarded_due_to_archive",
      payload: {
        turnJobId: 101,
        turnKind: "chat",
        reason: "session_archived",
      },
      actorType: "system",
      actorId: "legacy-compose-service",
      turnJobId: 101,
    });
    expect(composeRepository.appendSessionEvent).toHaveBeenCalledWith({
      sessionId: 7,
      eventType: "assistant.discarded_due_to_archive",
      payload: {
        turnJobId: 101,
        turnKind: "chat",
        reason: "session_archived",
      },
      actorType: "system",
      actorId: "legacy-compose-service",
      turnJobId: 101,
    });
    expect(sseHub.publish).not.toHaveBeenCalledWith(
      7,
      expect.objectContaining({ type: "message", role: "assistant" }),
    );
    expect(sseHub.publish).not.toHaveBeenCalledWith(
      7,
      expect.objectContaining({ type: "invalidate", resource: "readiness" }),
    );
    expect(sseHub.publish).not.toHaveBeenCalledWith(
      7,
      expect.objectContaining({ type: "status", status: "error" }),
    );
  });

  it("postMessage without an idempotency key discards the final response when archive wins the final transaction", async () => {
    const { service, composeRepository, chatAgent, workspaceManager, sseHub } =
      buildService();
    composeRepository.appendAssistantMessageIfSessionActive.mockResolvedValueOnce(
      {
        assistantMessageId: null,
        deduplicated: false,
        discardedDueToArchive: true,
      },
    );
    chatAgent.run.mockResolvedValue({
      envelope: {
        reply: "Ready",
        readiness: { ready: false, openQuestions: [], summary: "Needs more" },
      },
      sessionId: "claude-session",
      metrics: {},
    });

    await service.postMessage({
      sessionId: 7,
      content: "billing-service",
      actor: "kompallik",
    });
    await flushAsyncTurns();

    expect(
      composeRepository.appendAssistantMessageIfSessionActive,
    ).toHaveBeenCalledWith({
      sessionId: 7,
      content: "Ready",
      contextVersionUsed: null,
    });
    expect(composeRepository.appendMessage).toHaveBeenCalledTimes(1);
    expect(composeRepository.appendMessage).toHaveBeenCalledWith({
      sessionId: 7,
      role: "user",
      content: "billing-service",
    });
    expect(composeRepository.setClaudeSessionId).not.toHaveBeenCalled();
    expect(workspaceManager.prepare).toHaveBeenCalledTimes(1);
    expect(composeRepository.setReadiness).not.toHaveBeenCalled();
    expect(composeRepository.appendSessionEvent).toHaveBeenCalledWith({
      sessionId: 7,
      eventType: "assistant.discarded_due_to_archive",
      payload: {
        turnJobId: null,
        turnKind: "chat",
        reason: "session_archived",
      },
      actorType: "system",
      actorId: "legacy-compose-service",
      turnJobId: null,
    });
    expect(composeRepository.appendSessionEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "turn.discarded_due_to_archive",
      }),
    );
    expect(sseHub.publish).not.toHaveBeenCalledWith(
      7,
      expect.objectContaining({ type: "message", role: "assistant" }),
    );
    expect(sseHub.publish).not.toHaveBeenCalledWith(
      7,
      expect.objectContaining({ type: "invalidate", resource: "readiness" }),
    );
    expect(sseHub.publish).not.toHaveBeenCalledWith(
      7,
      expect.objectContaining({ type: "status", status: "error" }),
    );
  });

  it("executeClaimedTurn runs a claimed durable chat turn with the worker lease", async () => {
    const { service, composeRepository, chatAgent } = buildService();
    composeRepository.listMessages.mockResolvedValueOnce([
      {
        id: 51,
        sessionId: 7,
        role: "user",
        content: "queued durable body",
        createdAt: "2026-06-02T00:00:00.000Z",
      },
    ]);
    chatAgent.run.mockResolvedValueOnce({
      envelope: {
        reply: "Worker reply",
        readiness: {
          ready: false,
          openQuestions: [],
          summary: "Needs more detail",
        },
      },
      sessionId: "claude-worker",
      metrics: {},
    });

    await service.executeClaimedTurn({
      id: 101,
      sessionId: 7,
      turnKind: "chat",
      userMessageId: 51,
      status: "running",
      leaseGeneration: 3,
      activeWorkerId: "durable-worker-a",
    });

    expect(composeRepository.markTurnJobRunning).not.toHaveBeenCalled();
    expect(composeRepository.confirmTurnLease).toHaveBeenCalledWith({
      turnJobId: 101,
      workerId: "durable-worker-a",
      leaseGeneration: 3,
    });
    expect(chatAgent.run).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "chat",
        latestUserMessage: "queued durable body",
      }),
    );
    expect(
      composeRepository.completeTurnWithAssistantMessage,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        turnJobId: 101,
        sessionId: 7,
        content: "Worker reply",
        lease: {
          workerId: "durable-worker-a",
          leaseGeneration: 3,
        },
      }),
    );
    expect(composeRepository.appendSessionEvent).toHaveBeenCalledWith({
      sessionId: 7,
      eventType: "turn.started",
      payload: {
        turnJobId: 101,
        turnKind: "chat",
        workerId: "durable-worker-a",
        leaseGeneration: 3,
      },
      actorType: "system",
      actorId: "durable-worker-a",
      turnJobId: 101,
    });
    expect(composeRepository.appendSessionEvent).toHaveBeenCalledWith({
      sessionId: 7,
      eventType: "turn.completed",
      payload: {
        turnJobId: 101,
        turnKind: "chat",
        assistantMessageId: 52,
      },
      actorType: "system",
      actorId: "durable-worker-a",
      turnJobId: 101,
    });
  });

  it("executeClaimedTurn suppresses terminal side effects when the failure fence rejects the lease", async () => {
    const { service, composeRepository, chatAgent, sseHub } = buildService();
    composeRepository.listMessages.mockResolvedValueOnce([
      {
        id: 51,
        sessionId: 7,
        role: "user",
        content: "queued durable body",
        createdAt: "2026-06-02T00:00:00.000Z",
      },
    ]);
    composeRepository.markTurnJobFailed.mockResolvedValueOnce(false);
    chatAgent.run.mockRejectedValue(new Error("bedrock_throttled"));

    await expect(
      service.executeClaimedTurn({
        id: 101,
        sessionId: 7,
        turnKind: "chat",
        userMessageId: 51,
        status: "running",
        leaseGeneration: 3,
        activeWorkerId: "durable-worker-a",
      }),
    ).rejects.toThrow("bedrock_throttled");

    expect(composeRepository.markTurnJobFailed).toHaveBeenCalledWith({
      turnJobId: 101,
      errorMessage: "bedrock_throttled",
      lease: {
        workerId: "durable-worker-a",
        leaseGeneration: 3,
      },
    });
    expect(sseHub.publish).not.toHaveBeenCalledWith(
      7,
      expect.objectContaining({ type: "status", status: "error" }),
    );
    expect(composeRepository.recordSessionActivity).not.toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 7,
        action: "chat_failed",
      }),
    );
    expect(composeRepository.appendSessionEvent).toHaveBeenCalledWith({
      sessionId: 7,
      eventType: "turn.lease_fence_rejected",
      payload: {
        turnJobId: 101,
        turnKind: "chat",
        reason: "failure_write_rejected",
      },
      actorType: "system",
      actorId: "durable-worker-a",
      turnJobId: 101,
    });
  });

  it("executeClaimedTurn lets the coordinator answer from generated research after fan-in", async () => {
    const chatCoordinator = {
      decide: vi.fn().mockResolvedValue({
        action: "answer",
        answer: "Retry handling is in compose-database.ts.",
        confidence: "high",
        contextVersionUsed: 4,
      }),
    };
    const { service, composeRepository, chatAgent } = buildService({
      chatCoordinator,
    });
    composeRepository.getSession.mockResolvedValue(
      sessionSummary({
        latestContextVersion: 4,
        readiness: {
          ready: false,
          openQuestions: [],
          summary: "Research completed; synthesize the answer.",
        },
      }),
    );
    composeRepository.listMessages.mockResolvedValue([
      {
        id: 51,
        sessionId: 7,
        role: "user",
        content: "Where is retry implemented?",
        createdAt: "2026-06-02T00:00:00.000Z",
      },
    ]);
    composeRepository.listSessionSources.mockResolvedValue([
      {
        id: 31,
        sessionId: 7,
        kind: "generated_research",
        originalFilename: "code-research-task-501.md",
        mimeType: "text/markdown",
        sizeBytes: 512,
        sourceUrl: null,
        s3KeyRaw: null,
        converter: "generated",
        markdownPath: "compose/7/research/code-research-task-501.md",
        markdownContent:
          "# Research\n\nRetry handling is implemented in compose-database.ts.",
        sourceOrigin: "agent",
        generatedByTaskId: 501,
        parentSourceIds: [],
        contextVersionUsed: 4,
        artifactUri: "file:///research/code-research-task-501.md",
        artifactSha256: null,
        artifactBytes: null,
        conversionStatus: "converted",
        conversionStartedAt: null,
        conversionAttempts: 1,
        conversionLeaseExpiresAt: null,
        errorMessage: null,
        createdAt: "2026-06-02T00:00:00.000Z",
        updatedAt: "2026-06-02T00:00:00.000Z",
      },
    ]);
    composeRepository.listTurnAgentTasks.mockResolvedValue([
      {
        id: 501,
        capability: "code_research",
        status: "completed",
        executorType: "code_research",
        question: "Where is retry implemented?",
        maxCostUsd: 1.25,
        outputSourceId: 31,
        errorCode: null,
        errorMessage: null,
        attemptCount: 1,
        maxAttempts: 2,
        createdAt: "2026-06-02T00:00:00.000Z",
        completedAt: "2026-06-02T00:00:05.000Z",
      },
    ]);

    await service.executeClaimedTurn({
      id: 101,
      sessionId: 7,
      turnKind: "chat",
      userMessageId: 51,
      status: "running",
      leaseGeneration: 3,
      activeWorkerId: "durable-worker-a",
    });

    expect(chatCoordinator.decide).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessage: "Where is retry implemented?",
        requestedContextVersion: 4,
        contextVersionUsed: 4,
        generatedResearch: [
          expect.objectContaining({
            sourceId: 31,
            filename: "code-research-task-501.md",
            markdownContent: expect.stringContaining("compose-database.ts"),
            contextVersionUsed: 4,
          }),
        ],
        pendingTasks: [
          expect.objectContaining({
            id: 501,
            capability: "code_research",
            status: "completed",
            question: "Where is retry implemented?",
            outputSourceId: 31,
          }),
        ],
      }),
    );
    expect(chatAgent.run).not.toHaveBeenCalled();
    expect(
      composeRepository.completeTurnWithAssistantMessage,
    ).toHaveBeenCalledWith({
      turnJobId: 101,
      sessionId: 7,
      content: "Retry handling is in compose-database.ts.",
      contextVersionUsed: 4,
      finalPayload: {
        action: "answer",
        answer: "Retry handling is in compose-database.ts.",
        confidence: "high",
        contextVersionUsed: 4,
      },
      lease: {
        workerId: "durable-worker-a",
        leaseGeneration: 3,
      },
    });
  });

  it("postMessage in drain mode leaves the durable turn queued for a worker", async () =>
    withDurableTurnsMode("drain", async () => {
      const { service, composeRepository, chatAgent, sseHub } = buildService();

      const result = await service.postMessage({
        sessionId: 7,
        content: "billing-service",
        actor: "kompallik",
        idempotencyKey: "msg-abc",
      });
      await flushAsyncTurns();

      expect(result).toEqual({
        accepted: true,
        messageId: 51,
        turnJobId: 101,
        status: "queued",
      });
      expect(composeRepository.createMessageTurn).toHaveBeenCalledWith({
        sessionId: 7,
        content: "billing-service",
        idempotencyKey: "msg-abc",
        requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(composeRepository.markTurnJobRunning).not.toHaveBeenCalled();
      expect(chatAgent.run).not.toHaveBeenCalled();
      expect(
        composeRepository.completeTurnWithAssistantMessage,
      ).not.toHaveBeenCalled();
      expect(sseHub.publish).toHaveBeenCalledWith(7, {
        type: "message",
        role: "user",
        content: "billing-service",
      });
    }));

  it("analyze in drain mode leaves the durable turn queued for a worker", async () =>
    withDurableTurnsMode("drain", async () => {
      const { service, composeRepository, chatAgent } = buildService();

      const result = await service.analyze({
        sessionId: 7,
        repositoryIds: [5, 3, 5],
        actor: "kompallik",
        idempotencyKey: "analyze-abc",
      });
      await flushAsyncTurns();

      expect(result).toEqual({
        accepted: true,
        messageId: null,
        turnJobId: 102,
        status: "queued",
      });
      expect(composeRepository.createAnalyzeTurn).toHaveBeenCalledWith({
        sessionId: 7,
        idempotencyKey: "analyze-abc",
        requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(composeRepository.markTurnJobRunning).not.toHaveBeenCalled();
      expect(chatAgent.run).not.toHaveBeenCalled();
    }));

  it("postMessage in drain mode rejects non-durable turns before appending", async () =>
    withDurableTurnsMode("drain", async () => {
      const { service, composeRepository, chatAgent } = buildService();

      const result = await service.postMessage({
        sessionId: 7,
        content: "billing-service",
        actor: "kompallik",
      });
      await flushAsyncTurns();

      expect(result).toEqual({
        accepted: false,
        reason: "durable_turn_required",
      });
      expect(composeRepository.appendMessage).not.toHaveBeenCalled();
      expect(composeRepository.markTurnJobRunning).not.toHaveBeenCalled();
      expect(chatAgent.run).not.toHaveBeenCalled();
    }));

  it("postMessage queues a follow-up while the assistant turn is still running", async () => {
    const { service, chatAgent, composeRepository } = buildService();
    const firstTurn = deferred<{
      envelope: {
        reply: string;
        readiness: { ready: boolean; openQuestions: string[]; summary: string };
      };
      sessionId: string;
      metrics: Record<string, never>;
    }>();
    chatAgent.run.mockReturnValueOnce(firstTurn.promise).mockResolvedValueOnce({
      envelope: {
        reply: "Second turn complete.",
        readiness: { ready: true, openQuestions: [], summary: "ready" },
      },
      sessionId: "s",
      metrics: {},
    });

    await expect(
      service.postMessage({ sessionId: 7, content: "first answer" }),
    ).resolves.toEqual({ accepted: true });
    await expect(
      service.postMessage({ sessionId: 7, content: "follow-up detail" }),
    ).resolves.toEqual({ accepted: true });

    expect(composeRepository.appendMessage).toHaveBeenCalledWith({
      sessionId: 7,
      role: "user",
      content: "follow-up detail",
    });
    expect(chatAgent.run).toHaveBeenCalledTimes(1);

    firstTurn.resolve({
      envelope: {
        reply: "First turn complete.",
        readiness: { ready: false, openQuestions: ["Next?"], summary: "more" },
      },
      sessionId: "s",
      metrics: {},
    });
    await flushAsyncTurns();

    expect(chatAgent.run).toHaveBeenCalledTimes(2);
    expect(chatAgent.run.mock.calls[1][0]).toMatchObject({
      mode: "chat",
      latestUserMessage: "follow-up detail",
    });
  });

  it("reports the legacy in-memory queue state for drain gating", async () => {
    const { service, chatAgent } = buildService();
    const firstTurn = deferred<{
      envelope: {
        reply: string;
        readiness: { ready: boolean; openQuestions: string[]; summary: string };
      };
      sessionId: string;
      metrics: Record<string, never>;
    }>();
    chatAgent.run.mockReturnValueOnce(firstTurn.promise).mockResolvedValueOnce({
      envelope: {
        reply: "Second turn complete.",
        readiness: { ready: true, openQuestions: [], summary: "ready" },
      },
      sessionId: "s",
      metrics: {},
    });

    expect(service.getLegacyTurnQueueHealth()).toEqual({
      legacyInflight: 0,
      legacyQueued: 0,
    });

    await expect(
      service.postMessage({ sessionId: 7, content: "first answer" }),
    ).resolves.toEqual({ accepted: true });
    await flushAsyncTurns(2);
    await expect(
      service.postMessage({ sessionId: 7, content: "follow-up detail" }),
    ).resolves.toEqual({ accepted: true });

    expect(service.getLegacyTurnQueueHealth()).toEqual({
      legacyInflight: 1,
      legacyQueued: 1,
    });

    firstTurn.resolve({
      envelope: {
        reply: "First turn complete.",
        readiness: { ready: false, openQuestions: ["Next?"], summary: "more" },
      },
      sessionId: "s",
      metrics: {},
    });
    await flushAsyncTurns();

    expect(service.getLegacyTurnQueueHealth()).toEqual({
      legacyInflight: 0,
      legacyQueued: 0,
    });
  });

  it("logs a queued turn failure instead of swallowing it silently", async () => {
    const { service, chatAgent } = buildService();
    const logSpy = vi
      .spyOn(
        service as unknown as { logTurnFailure: (...args: unknown[]) => void },
        "logTurnFailure",
      )
      .mockImplementation(() => undefined);
    chatAgent.run.mockRejectedValue(new Error("model exploded"));

    await expect(
      service.postMessage({ sessionId: 7, content: "answer" }),
    ).resolves.toEqual({ accepted: true });
    await flushAsyncTurns();

    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 7, mode: "chat" }),
      expect.any(Error),
    );
  });

  it("rejects new turns with queue_full once the per-session queue is saturated", async () => {
    const { service, chatAgent } = buildService();
    // Hold every turn open so the queue depth grows.
    const gate = deferred<void>();
    chatAgent.run.mockImplementation(async () => {
      await gate.promise;
      return {
        envelope: {
          reply: "ok",
          readiness: { ready: false, openQuestions: [], summary: "" },
        },
        sessionId: "s",
        metrics: {},
      };
    });

    const accepted: boolean[] = [];
    for (let i = 0; i < 6; i += 1) {
      const result = await service.postMessage({
        sessionId: 7,
        content: `msg ${i}`,
      });
      accepted.push(result.accepted);
    }

    // The first few are accepted; once the cap is hit, further turns are rejected.
    expect(accepted.filter(Boolean).length).toBeLessThan(6);
    expect(accepted).toContain(false);
    const rejected = await service.postMessage({ sessionId: 7, content: "x" });
    expect(rejected).toEqual({ accepted: false, reason: "queue_full" });

    gate.resolve();
    await flushAsyncTurns();
  });

  it("retries a transient chat-turn failure and publishes a retrying status", async () => {
    const { service, chatAgent, sseHub } = buildService();
    chatAgent.run
      .mockRejectedValueOnce(
        Object.assign(new Error("ThrottlingException: rate exceeded"), {}),
      )
      .mockResolvedValueOnce({
        envelope: {
          reply: "ok",
          readiness: { ready: true, openQuestions: [], summary: "ready" },
        },
        sessionId: "s",
        metrics: {},
      });

    await service.analyze({ sessionId: 7 });
    await flushAsyncTurns(40);

    expect(chatAgent.run).toHaveBeenCalledTimes(2);
    const retryingEvents = sseHub.publish.mock.calls
      .map((call) => call[1])
      .filter(
        (event) =>
          event.type === "status" && (event as any).status === "retrying",
      );
    expect(retryingEvents.length).toBeGreaterThanOrEqual(1);
    expect(retryingEvents[0]).toMatchObject({
      type: "status",
      status: "retrying",
      attempt: 1,
      maxAttempts: 3,
    });
    expect(typeof (retryingEvents[0] as any).nextRetryInSeconds).toBe("number");
    const errorEvents = sseHub.publish.mock.calls
      .map((call) => call[1])
      .filter(
        (event) => event.type === "status" && (event as any).status === "error",
      );
    expect(errorEvents).toHaveLength(0);
    const idleEvents = sseHub.publish.mock.calls
      .map((call) => call[1])
      .filter(
        (event) => event.type === "status" && (event as any).status === "idle",
      );
    expect(idleEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("does not retry deterministic chat-turn failures", async () => {
    const { service, chatAgent, sseHub } = buildService();
    chatAgent.run.mockRejectedValue(
      new Error("ValidationError: bad request body"),
    );

    await service.analyze({ sessionId: 7 });
    await flushAsyncTurns(20);

    expect(chatAgent.run).toHaveBeenCalledTimes(1);
    const retryingEvents = sseHub.publish.mock.calls
      .map((call) => call[1])
      .filter(
        (event) =>
          event.type === "status" && (event as any).status === "retrying",
      );
    expect(retryingEvents).toHaveLength(0);
    const errorEvents = sseHub.publish.mock.calls
      .map((call) => call[1])
      .filter(
        (event) => event.type === "status" && (event as any).status === "error",
      );
    expect(errorEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("does not retry a Claude SDK wall-budget timeout", async () => {
    const { service, chatAgent, sseHub } = buildService();
    chatAgent.run.mockRejectedValue(new Error("SDK timeout after 300000ms"));

    await service.analyze({ sessionId: 7 });
    await flushAsyncTurns(20);

    expect(chatAgent.run).toHaveBeenCalledTimes(1);
    const retryingEvents = sseHub.publish.mock.calls
      .map((call) => call[1])
      .filter(
        (event) =>
          event.type === "status" && (event as any).status === "retrying",
      );
    expect(retryingEvents).toHaveLength(0);
  });

  it("exhausts retries on persistent transient failures and publishes error", async () => {
    const { service, chatAgent, sseHub } = buildService();
    chatAgent.run.mockRejectedValue(new Error("503 Service Unavailable"));

    await service.analyze({ sessionId: 7 });
    await flushAsyncTurns(60);

    // 1 initial attempt + 2 retries = 3 calls
    expect(chatAgent.run).toHaveBeenCalledTimes(3);
    const retryingEvents = sseHub.publish.mock.calls
      .map((call) => call[1])
      .filter(
        (event) =>
          event.type === "status" && (event as any).status === "retrying",
      );
    expect(retryingEvents.length).toBe(2);
    const errorEvents = sseHub.publish.mock.calls
      .map((call) => call[1])
      .filter(
        (event) => event.type === "status" && (event as any).status === "error",
      );
    expect(errorEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("attaches grounded repos and records the agent's real code investigation on readiness", async () => {
    const { service, chatAgent, composeRepository, repoGrounding } =
      buildService();
    repoGrounding.groundRepos.mockResolvedValue({
      codeRepoIds: ["rid-core-app"],
      repositoriesMarkdown: "# repos",
      manifest: [
        {
          repoName: "core-app",
          headSha: "b83cdc2",
          techStack: "Java",
          inspectedPaths: ["App.java"],
          keyMatches: [],
          warnings: [],
        },
      ],
    });
    chatAgent.run.mockResolvedValue({
      envelope: {
        reply: "Confirmed the API exists.",
        readiness: { ready: true, openQuestions: [], summary: "ok" },
      },
      sessionId: "s",
      metrics: {
        toolCalls: 15,
        sdkLifecycleSummary: { distinctFilesRead: 6, readCount: 6 },
      },
    });

    await service.analyze({ sessionId: 7, repositoryIds: [3] });
    await flushAsyncTurns();

    // Code repos were attached to the agent.
    expect(chatAgent.run.mock.calls[0][0].codeRepoIds).toEqual([
      "rid-core-app",
    ]);
    // Readiness carries both the pre-scan manifest AND the real investigation.
    const saved =
      composeRepository.setReadiness.mock.calls.at(-1)?.[0]?.readiness;
    expect(saved.repoEvidence?.[0]?.repoName).toBe("core-app");
    expect(saved.codeInvestigation).toEqual({ filesRead: 6, toolCalls: 15 });
  });

  it("publishes phase-specific progress while running a turn", async () => {
    const { service, chatAgent, sseHub } = buildService();
    chatAgent.run.mockResolvedValue({
      envelope: {
        reply: "Ready.",
        readiness: { ready: true, openQuestions: [], summary: "ready" },
      },
      sessionId: "sess-1",
      metrics: {},
    });

    await service.analyze({ sessionId: 7 });
    await flushAsyncTurns();

    const progressMessages = sseHub.publish.mock.calls
      .map((call) => call[1])
      .filter((event) => event.type === "status")
      .map((event) => event.message)
      .filter(Boolean);
    expect(progressMessages).toEqual(
      expect.arrayContaining([
        "Reading sources",
        "Checking repositories",
        "Updating brief",
        "Preparing next question",
      ]),
    );
  });

  it("prepares converted sources for analyze and rewrites chat with the assistant reply", async () => {
    const { service, composeRepository, chatAgent, workspaceManager } =
      buildService();
    composeRepository.getSession.mockResolvedValue(
      sessionSummary({ id: 7, workspacePath: "/w/7", claudeSessionId: null }),
    );
    composeRepository.listMessages.mockResolvedValueOnce([
      {
        id: 1,
        sessionId: 7,
        role: "user",
        content: "Need export.",
        createdAt: "t",
      },
    ]);
    composeRepository.listSessionSourceContents.mockResolvedValue([
      {
        sourceId: 21,
        filename: "requirements.docx",
        content: "Build CSV export.",
      },
    ]);
    chatAgent.run.mockResolvedValue({
      envelope: {
        reply: "Ready.",
        readiness: {
          ready: true,
          openQuestions: [],
          summary: "CSV export ready",
        },
        contextMarkdown: "# Context\n\nCSV export ready.",
      },
      sessionId: "sess-1",
      metrics: {},
    });

    await service.analyze({ sessionId: 7 });
    await flushAsyncTurns();

    expect(workspaceManager.prepare.mock.calls[0][0]).toMatchObject({
      workspacePath: "/w/7",
      sources: [
        {
          sourceId: 21,
          filename: "requirements.docx",
          content: "Build CSV export.",
        },
      ],
      messages: [{ role: "user", content: "Need export." }],
    });
    expect(workspaceManager.prepare.mock.calls.at(-1)?.[0]).toMatchObject({
      workspacePath: "/w/7",
      contextMarkdown: "# Context\n\nCSV export ready.",
      messages: [
        { role: "user", content: "Need export." },
        { role: "assistant", content: "Ready." },
      ],
    });
    expect(workspaceManager.prepare.mock.calls.at(-1)?.[0]).not.toHaveProperty(
      "sources",
    );
    expect(composeRepository.listMessages).toHaveBeenCalledTimes(1);
  });

  it("postMessage rejects a blank message", async () => {
    const { service } = buildService();
    await expect(
      service.postMessage({ sessionId: 7, content: "   " }),
    ).rejects.toThrow(/message/i);
  });

  it("postMessage throws (not-found) for a missing session", async () => {
    const { service, composeRepository } = buildService();
    composeRepository.getSession.mockResolvedValue(null);
    await expect(
      service.postMessage({ sessionId: 999, content: "hi" }),
    ).rejects.toThrow(/not found/i);
    expect(composeRepository.appendMessage).not.toHaveBeenCalled();
  });

  it("postMessage rejects a concurrent turn on the same session", async () => {
    const { service, chatAgent } = buildService();
    let release: () => void = () => {};
    chatAgent.run.mockReturnValueOnce(
      new Promise((r) => {
        release = () =>
          r({
            envelope: {
              reply: "x",
              readiness: { ready: false, openQuestions: [], summary: "" },
            },
            sessionId: "s",
            metrics: {},
          });
      }),
    );
    const first = service.postMessage({ sessionId: 7, content: "a" });
    await expect(
      service.postMessage({ sessionId: 7, content: "b" }),
    ).resolves.toEqual({ accepted: true });
    release();
    await first;
  });

  it("listMessages delegates to the repository", async () => {
    const { service, composeRepository } = buildService();
    composeRepository.listMessages.mockResolvedValue([
      { id: 1, sessionId: 7, role: "user", content: "hi", createdAt: "t" },
    ]);
    expect(await service.listMessages(7)).toHaveLength(1);
  });

  describe("stream/content authorization tokens", () => {
    it("resumeSession mints a stream token for protected sessions", async () => {
      const { service, composeRepository } = buildService();
      await service.createSession({
        name: "Billing export",
        createdBy: null,
        createdByDisplay: null,
        password: "secret",
      });
      const passwordHash =
        composeRepository.createSession.mock.calls[0][0].passwordHash;
      composeRepository.getSession.mockResolvedValue(
        sessionSummary({ passwordProtected: true }),
      );
      composeRepository.getSessionPasswordHash.mockResolvedValue(passwordHash);

      const session = await service.resumeSession({
        sessionId: 7,
        password: "secret",
      });

      expect(session.streamToken).toMatch(/^[a-f0-9]{64}$/);
      const tokenHash = createHash("sha256")
        .update(session.streamToken ?? "")
        .digest("hex");
      expect(composeRepository.createStreamToken).toHaveBeenCalledWith({
        tokenHash,
        sessionId: 7,
        expiresAt: expect.any(Date),
      });
      expect(tokenHash).not.toBe(session.streamToken);

      composeRepository.verifyStreamTokenHash.mockResolvedValueOnce(true);
      await expect(
        service.verifyStreamToken(7, session.streamToken),
      ).resolves.toBe(true);
      expect(composeRepository.verifyStreamTokenHash).toHaveBeenCalledWith({
        tokenHash,
        sessionId: 7,
      });
    });

    it("resumeSession on an unprotected session does not mint a token", async () => {
      const { service } = buildService();
      const session = await service.resumeSession({
        sessionId: 7,
        password: null,
      });
      // Unprotected sessions return no token — the route layer gates
      // verification on isSessionPasswordProtected, not the token itself.
      expect((session as { streamToken?: string }).streamToken).toBeUndefined();
      expect(await service.isSessionPasswordProtected(7)).toBe(false);
    });

    it("isSessionPasswordProtected rejects archived sessions before protected reads", async () => {
      const { service, composeRepository } = buildService();
      composeRepository.getSession.mockResolvedValue(
        sessionSummary({ status: "archived" }),
      );

      await expect(service.isSessionPasswordProtected(7)).rejects.toThrow(
        /not found/i,
      );
    });

    it("verifyStreamToken rejects an invalid or missing token", async () => {
      const { service, composeRepository } = buildService();
      await expect(service.verifyStreamToken(7, "deadbeef")).resolves.toBe(
        false,
      );
      await expect(service.verifyStreamToken(7, null)).resolves.toBe(false);
      await expect(service.verifyStreamToken(7, undefined)).resolves.toBe(
        false,
      );
      await expect(service.verifyStreamToken(7, "")).resolves.toBe(false);
      expect(composeRepository.verifyStreamTokenHash).toHaveBeenCalledTimes(1);
    });

    it("verifyStreamToken rejects a token rejected by the shared store", async () => {
      const { service, composeRepository } = buildService();
      await service.createSession({
        name: "Billing export",
        createdBy: null,
        createdByDisplay: null,
        password: "secret",
      });
      const passwordHash =
        composeRepository.createSession.mock.calls[0][0].passwordHash;
      composeRepository.getSession.mockResolvedValue(
        sessionSummary({ passwordProtected: true }),
      );
      composeRepository.getSessionPasswordHash.mockResolvedValue(passwordHash);

      const session = await service.resumeSession({
        sessionId: 7,
        password: "secret",
      });

      await expect(
        service.verifyStreamToken(7, session.streamToken),
      ).resolves.toBe(false);
    });

    it("deleteSession revokes minted stream tokens before archive completes", async () => {
      const { service, composeRepository } = buildService();
      await service.createSession({
        name: "Billing export",
        createdBy: null,
        createdByDisplay: null,
        password: "secret",
      });
      const passwordHash =
        composeRepository.createSession.mock.calls[0][0].passwordHash;
      composeRepository.getSession.mockResolvedValue(
        sessionSummary({ passwordProtected: true }),
      );
      composeRepository.getSessionPasswordHash.mockResolvedValue(passwordHash);

      await service.resumeSession({
        sessionId: 7,
        password: "secret",
      });

      await service.deleteSession({ sessionId: 7, password: "secret" });

      expect(composeRepository.revokeSessionStreamTokens).toHaveBeenCalledWith(
        7,
      );
      expect(
        composeRepository.revokeSessionStreamTokens.mock.invocationCallOrder[0],
      ).toBeLessThan(
        composeRepository.archiveSessionWithWorkCancellation.mock
          .invocationCallOrder[0],
      );
      expect(
        composeRepository.archiveSessionWithWorkCancellation,
      ).toHaveBeenCalledWith(7);
    });
  });
});
