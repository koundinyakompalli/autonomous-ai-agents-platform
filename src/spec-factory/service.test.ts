import { beforeEach, describe, expect, it, vi } from "vitest";
import { JiraPublisher } from "./jira-publisher.js";
import { SpecFactoryService } from "./service.js";
import type { SpecFactoryTaskWorkspace } from "./evidence-workspace.js";
import type { SpecFactoryQualificationDecision } from "./qualifier.js";
import type { SpecFactoryRepoContextManifest } from "./repo-context.js";
import type {
  SpecFactoryDraftBundle,
  SpecFactoryDraftDetail,
  SpecFactorySourceSummary,
} from "./types.js";

function validBundle(): SpecFactoryDraftBundle {
  return {
    sourceJiraKey: "CPDEV-22410",
    loeHours: 38,
    epic: {
      summary: "Automate enrollment sync validation",
      description: "Client A needs repeatable validation.",
      businessContext: ["Louise estimated this as a cross-repo item."],
      acceptanceCriteria: ["Generated stories cover each repo change."],
      assumptions: [],
      dependencies: [],
    },
    childTickets: [
      {
        repoName: "core-app",
        repoId: 7,
        summary: "[core-app] Add validation",
        overview: "Implement backend validation.",
        acceptanceCriteria: [
          "Reject invalid payloads.",
          "Preserve other clients.",
        ],
        technicalDetails: {
          repo: "core-app",
          branch: "master",
          targetFiles: ["service/Validator.java"],
          implementationNotes: ["Use the existing validator."],
        },
        outOfScope: [],
        testingNotes: ["Run unit tests."],
        loeHours: 20,
        sourceEvidenceRefs: ["attachment:loe.md"],
      },
    ],
    evidenceSummary: ["Louise estimated 38 hours."],
    warnings: [],
  };
}

function sourceSummary(
  overrides: Partial<
    SpecFactorySourceSummary & { nextDraftVersion: number }
  > = {},
) {
  return {
    id: 12,
    sourceJiraKey: "CPDEV-22410",
    sourceSummary: "Enrollment sync rules",
    sourceStatus: "In Progress",
    loeHours: 38,
    state: "candidate" as const,
    origin: "louise" as const,
    approvedEpicKey: null,
    qualificationReasons: [],
    errorMessage: null,
    updatedAt: "2026-05-27T12:00:00.000Z",
    nextDraftVersion: 3,
    ...overrides,
  };
}

function draftDetail(
  overrides: Partial<SpecFactoryDraftDetail> = {},
): SpecFactoryDraftDetail {
  return {
    id: 44,
    sourceId: 12,
    version: 3,
    evidenceSnapshotId: null,
    status: "ready",
    draft: validBundle(),
    renderedMarkdown: "# Draft",
    evidenceManifest: { refs: ["jira:CPDEV-22410"] },
    childTickets: [
      {
        id: 99,
        repoName: "core-app",
        summary: "[core-app] Add validation",
        description: "Persisted child description",
        loeHours: 20,
        jiraKey: null,
        state: "draft",
        oneshotRequestId: null,
        oneshotRunId: null,
        errorMessage: null,
      },
    ],
    errorMessage: null,
    createdAt: "2026-05-27T12:00:00.000Z",
    updatedAt: "2026-05-27T12:05:00.000Z",
    ...overrides,
  };
}

function repoContext(
  overrides: Partial<SpecFactoryRepoContextManifest> = {},
): SpecFactoryRepoContextManifest {
  return {
    sourceJiraKey: "CPDEV-22410",
    repos: [
      {
        repoName: "core-app",
        repoId: "7",
        branch: "master",
        headSha: "abc123",
        workspacePath: "/tmp/core-app",
        inspectedPaths: ["service/Validator.java"],
        evidenceRefs: ["attachment:loe.md"],
        summaries: [],
        warnings: [],
      },
    ],
    unresolvedHints: [],
    warnings: [],
    ...overrides,
  };
}

function taskWorkspace(
  overrides: Partial<SpecFactoryTaskWorkspace> = {},
): SpecFactoryTaskWorkspace {
  return {
    repoId: "spec-factory-task-12",
    workspacePath: "/tmp/spec-factory/tasks/12",
    evidenceDir: "/tmp/spec-factory/tasks/12/evidence",
    attachmentsDir: "/tmp/spec-factory/tasks/12/evidence/attachments",
    reposDir: "/tmp/spec-factory/tasks/12/repos",
    repoLinks: [],
    ...overrides,
  };
}

function qualificationDecision(
  overrides: Partial<SpecFactoryQualificationDecision> = {},
): SpecFactoryQualificationDecision {
  return {
    qualified: true,
    reasons: [],
    confidence: "high",
    summary: "Evidence describes implementation work with a repo hint.",
    evidenceRefs: ["attachment:Development-Plan-CPDEV-22410.md"],
    repoHints: [
      {
        repoName: "core-app",
        evidenceRefs: ["attachment:Development-Plan-CPDEV-22410.md"],
        confidence: "high",
      },
    ],
    warnings: [],
    modelMetadata: {
      provider: "bedrock",
      model: "claude",
      metrics: {},
    },
    ...overrides,
  };
}

function makeDeps() {
  const repository = {
    listLouiseBoardSources: vi.fn(),
    getLatestIntakeRefreshAt: vi.fn(),
    recordIntakeRefresh: vi.fn(),
    getSourceById: vi.fn(),
    createDraft: vi.fn(),
    reviseDraft: vi.fn(),
    markSourceDrafting: vi.fn(),
    getLatestDraft: vi.fn(),
    markSourceNeedsAttention: vi.fn(),
    markSourceNotQualified: vi.fn(),
    markDraftGenerationFailed: vi.fn(),
    archiveSource: vi.fn(),
    restoreArchivedSource: vi.fn(),
    createProcessingJob: vi.fn(),
    expireStaleProcessingJobs: vi.fn(),
    expireStaleQueuedProcessingJobs: vi.fn(),
    claimNextProcessingJob: vi.fn(),
    completeProcessingJob: vi.fn(),
    failProcessingJob: vi.fn(),
    getProcessingJobHealth: vi.fn(),
    listSourceEvents: vi.fn(),
    listSourceAttachments: vi.fn(),
    markDraftApproved: vi.fn(),
    updateSourceApproved: vi.fn(),
    updateChildCreated: vi.fn(),
    listApprovedChildren: vi.fn(),
    updateChildSubmitted: vi.fn(),
    markSourceOneShotSubmitted: vi.fn(),
    recordEvent: vi.fn(),
    listOneShotSubmissions: vi.fn(),
    listArchivedSources: vi.fn(),
    getSourceOrigin: vi.fn(),
    createDraftWorkflow: vi.fn(),
  };
  const ingestor = { refresh: vi.fn() };
  const evidenceCollector = { collect: vi.fn() };
  const composeEvidenceProvider = { collect: vi.fn() };
  const composeHealthProvider = {
    getConversionQueueHealth: vi.fn(),
    getControlPlaneHealth: vi.fn(),
  };
  const repoContextCollector = { collect: vi.fn() };
  const generator = { generate: vi.fn() };
  const publisher = { approveDraft: vi.fn() };
  const submitter = { submitChildren: vi.fn() };
  const taskWorkspaceManager = { prepare: vi.fn() };
  const qualifier = { qualify: vi.fn() };
  repository.claimNextProcessingJob.mockResolvedValue(null);
  repository.expireStaleProcessingJobs.mockResolvedValue(0);
  repository.expireStaleQueuedProcessingJobs.mockResolvedValue(0);
  repository.recordIntakeRefresh.mockResolvedValue(undefined);
  repository.getSourceOrigin.mockResolvedValue("louise");
  repository.listSourceEvents.mockResolvedValue([]);
  repository.listSourceAttachments.mockResolvedValue([]);
  repository.getProcessingJobHealth.mockResolvedValue({
    byStatus: { queued: 0, running: 0, succeeded: 0, failed: 0 },
    staleRunning: 0,
    oldestQueuedAt: null,
    oldestRunningAt: null,
  });
  composeHealthProvider.getConversionQueueHealth.mockResolvedValue({
    byStatus: {
      awaiting_upload: 0,
      pending: 0,
      converting: 0,
      converted: 0,
      unsupported: 0,
      failed: 0,
    },
    inFlight: 0,
    retryable: 0,
    oldestPendingAt: null,
    oldestConvertingAt: null,
  });
  composeHealthProvider.getControlPlaneHealth.mockResolvedValue({
    turns: {
      byStatus: {
        queued: 0,
        running: 0,
        waiting_on_research: 0,
        awaiting_user_input: 0,
        synthesizing: 0,
        completed: 0,
        failed: 0,
        abandoned: 0,
        cancelled: 0,
      },
      durableQueued: 0,
      durableRunning: 0,
      durableAbandoned: 0,
      legacyInflight: 0,
      legacyQueued: 0,
      leaseExpired: 0,
      leaseFenceRejected: 0,
      oldestQueuedAt: null,
      oldestRunningAt: null,
    },
    agentTasks: {
      byStatus: {
        queued: 0,
        running: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
        abandoned: 0,
      },
      queued: 0,
      running: 0,
      completed: 0,
      failed: 0,
      abandoned: 0,
      leaseExpired: 0,
      leaseFenceRejected: 0,
      oldestQueuedAt: null,
      oldestRunningAt: null,
    },
    llm: {
      callsToday: 0,
      failedToday: 0,
      inputTokensToday: 0,
      outputTokensToday: 0,
      estimatedCostUsdToday: 0,
      latestCallAt: null,
    },
    workers: {
      total: 0,
      live: 0,
      stale: 0,
      byMode: {
        "all-local": {
          total: 0,
          live: 0,
          stale: 0,
          latestHeartbeatAt: null,
        },
        api: { total: 0, live: 0, stale: 0, latestHeartbeatAt: null },
        worker: { total: 0, live: 0, stale: 0, latestHeartbeatAt: null },
        "research-worker": {
          total: 0,
          live: 0,
          stale: 0,
          latestHeartbeatAt: null,
        },
        "conversion-worker": {
          total: 0,
          live: 0,
          stale: 0,
          latestHeartbeatAt: null,
        },
      },
    },
  });
  qualifier.qualify.mockResolvedValue(qualificationDecision());
  const service = new SpecFactoryService(
    repository as any,
    ingestor,
    evidenceCollector,
    repoContextCollector,
    generator,
    publisher,
    submitter,
    taskWorkspaceManager,
    {
      repoDeepDiveEnabled: true,
      qualifier,
      composeEvidenceProvider,
      composeHealthProvider,
    },
  );

  return {
    service,
    repository,
    ingestor,
    evidenceCollector,
    composeEvidenceProvider,
    composeHealthProvider,
    repoContextCollector,
    generator,
    publisher,
    submitter,
    evidenceWorkspaceManager: taskWorkspaceManager,
    qualifier,
  };
}

describe("SpecFactoryService", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("refreshLouiseBoard refreshes the ingestor then returns board sources", async () => {
    const deps = makeDeps();
    const refresh = {
      scanned: 2,
      upserted: 2,
      matched: 3,
      truncated: true,
      claimed: 2,
      claimFailures: 0,
      newSources: [],
    };
    const sources = [sourceSummary()];
    deps.ingestor.refresh.mockResolvedValueOnce(refresh);
    deps.repository.listLouiseBoardSources.mockResolvedValueOnce(sources);

    await expect(deps.service.refreshLouiseBoard()).resolves.toEqual({
      refresh: {
        status: "completed",
        scanned: 2,
        upserted: 2,
        matched: 3,
        truncated: true,
        claimed: 2,
        claimFailures: 0,
        autoQueued: 0,
      },
      sources,
    });
    expect(deps.ingestor.refresh.mock.invocationCallOrder[0]).toBeLessThan(
      deps.repository.listLouiseBoardSources.mock.invocationCallOrder[0],
    );
  });

  it("refreshLouiseBoard shares an in-flight refresh across callers", async () => {
    const deps = makeDeps();
    const refresh = {
      scanned: 2,
      upserted: 2,
      matched: 3,
      truncated: true,
      claimed: 2,
      claimFailures: 0,
      newSources: [],
    };
    const sources = [sourceSummary()];
    let releaseRefresh: (() => void) | undefined;

    deps.ingestor.refresh.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseRefresh = () => resolve(refresh);
      }),
    );
    deps.repository.listLouiseBoardSources
      .mockResolvedValueOnce(sources)
      .mockResolvedValueOnce(sources);

    const first = deps.service.refreshLouiseBoard();
    const second = deps.service.refreshLouiseBoard();
    releaseRefresh?.();

    await expect(first).resolves.toEqual({
      refresh: {
        status: "completed",
        scanned: 2,
        upserted: 2,
        matched: 3,
        truncated: true,
        claimed: 2,
        claimFailures: 0,
        autoQueued: 0,
      },
      sources,
    });
    await expect(second).resolves.toEqual({
      refresh: {
        status: "completed",
        scanned: 2,
        upserted: 2,
        matched: 3,
        truncated: true,
        claimed: 2,
        claimFailures: 0,
        autoQueued: 0,
      },
      sources,
    });
    expect(deps.ingestor.refresh).toHaveBeenCalledTimes(1);
    expect(deps.repository.listLouiseBoardSources).toHaveBeenCalledTimes(2);
  });

  it("requestLouiseBoardRefresh skips Jira when the board cache is fresh", async () => {
    const deps = makeDeps();
    const sources = [sourceSummary()];
    deps.repository.getLatestIntakeRefreshAt.mockResolvedValueOnce(
      new Date().toISOString(),
    );
    deps.repository.listLouiseBoardSources.mockResolvedValueOnce(sources);

    const result = await deps.service.requestLouiseBoardRefresh();

    expect(result.refresh.status).toBe("skipped");
    expect(result.refresh.reason).toBe("fresh_cache");
    expect(result.sources).toBe(sources);
    expect(deps.ingestor.refresh).not.toHaveBeenCalled();
  });

  it("listBoardSources returns active board sources", async () => {
    const deps = makeDeps();
    const sources = [sourceSummary()];
    deps.repository.listLouiseBoardSources.mockResolvedValueOnce(sources);

    await expect(deps.service.listBoardSources()).resolves.toBe(sources);
  });

  it("getSource reads a source by id independently of the board page", async () => {
    const deps = makeDeps();
    const source = { ...sourceSummary(), nextDraftVersion: 3 };
    deps.repository.getSourceById.mockResolvedValueOnce(source);

    await expect(deps.service.getSource(1671)).resolves.toBe(source);
    expect(deps.repository.getSourceById).toHaveBeenCalledWith(1671);
  });

  it("requestBoardRefresh exposes the neutral board refresh contract", async () => {
    const deps = makeDeps();
    const sources = [sourceSummary()];
    deps.repository.getLatestIntakeRefreshAt.mockResolvedValueOnce(
      new Date().toISOString(),
    );
    deps.repository.listLouiseBoardSources.mockResolvedValueOnce(sources);

    const result = await deps.service.requestBoardRefresh();

    expect(result.refresh.status).toBe("skipped");
    expect(result.sources).toBe(sources);
    expect(deps.ingestor.refresh).not.toHaveBeenCalled();
  });

  it("getStatus summarizes board, processing, and compose conversion health", async () => {
    const deps = makeDeps();
    deps.repository.listLouiseBoardSources.mockResolvedValueOnce([
      sourceSummary({
        id: 1,
        state: "candidate",
        origin: "louise",
        updatedAt: "2026-06-08T11:00:00.000Z",
      }),
      sourceSummary({
        id: 2,
        state: "draft_ready",
        origin: "compose",
        updatedAt: "2026-06-08T11:01:00.000Z",
      }),
      sourceSummary({
        id: 3,
        state: "needs_attention",
        origin: "compose",
        updatedAt: "2026-06-08T11:02:00.000Z",
      }),
    ]);
    deps.repository.getLatestIntakeRefreshAt.mockResolvedValueOnce(
      "2026-06-08T10:55:00.000Z",
    );
    deps.repository.getProcessingJobHealth.mockResolvedValueOnce({
      byStatus: { queued: 2, running: 1, succeeded: 8, failed: 1 },
      staleRunning: 1,
      oldestQueuedAt: "2026-06-08T10:59:00.000Z",
      oldestRunningAt: "2026-06-08T10:00:00.000Z",
    });
    deps.composeHealthProvider.getConversionQueueHealth.mockResolvedValueOnce({
      byStatus: {
        awaiting_upload: 1,
        pending: 2,
        converting: 1,
        converted: 5,
        unsupported: 1,
        failed: 2,
      },
      inFlight: 4,
      retryable: 3,
      oldestPendingAt: "2026-06-08T11:03:00.000Z",
      oldestConvertingAt: "2026-06-08T11:04:00.000Z",
    });
    deps.composeHealthProvider.getControlPlaneHealth.mockResolvedValueOnce({
      turns: {
        byStatus: {
          queued: 4,
          running: 2,
          waiting_on_research: 1,
          awaiting_user_input: 1,
          synthesizing: 0,
          completed: 20,
          failed: 1,
          abandoned: 3,
          cancelled: 1,
        },
        durableQueued: 4,
        durableRunning: 4,
        durableAbandoned: 3,
        legacyInflight: 2,
        legacyQueued: 1,
        leaseExpired: 2,
        leaseFenceRejected: 5,
        oldestQueuedAt: "2026-06-08T11:01:00.000Z",
        oldestRunningAt: "2026-06-08T11:02:00.000Z",
      },
      agentTasks: {
        byStatus: {
          queued: 5,
          running: 2,
          completed: 13,
          failed: 1,
          cancelled: 0,
          abandoned: 2,
        },
        queued: 5,
        running: 2,
        completed: 13,
        failed: 1,
        abandoned: 2,
        leaseExpired: 1,
        leaseFenceRejected: 4,
        oldestQueuedAt: "2026-06-08T11:05:00.000Z",
        oldestRunningAt: "2026-06-08T11:06:00.000Z",
      },
      llm: {
        callsToday: 9,
        failedToday: 2,
        inputTokensToday: 1500,
        outputTokensToday: 700,
        estimatedCostUsdToday: 1.75,
        latestCallAt: "2026-06-08T11:07:00.000Z",
      },
      workers: {
        total: 3,
        live: 2,
        stale: 1,
        byMode: {
          "all-local": {
            total: 0,
            live: 0,
            stale: 0,
            latestHeartbeatAt: null,
          },
          api: {
            total: 1,
            live: 1,
            stale: 0,
            latestHeartbeatAt: "2026-06-08T11:07:00.000Z",
          },
          worker: {
            total: 1,
            live: 0,
            stale: 1,
            latestHeartbeatAt: "2026-06-08T11:05:00.000Z",
          },
          "research-worker": {
            total: 1,
            live: 1,
            stale: 0,
            latestHeartbeatAt: "2026-06-08T11:06:00.000Z",
          },
          "conversion-worker": {
            total: 0,
            live: 0,
            stale: 0,
            latestHeartbeatAt: null,
          },
        },
      },
    });

    const status = await deps.service.getStatus();

    expect(status.board).toMatchObject({
      activeSourceCount: 3,
      latestRefreshAt: "2026-06-08T10:55:00.000Z",
      byOrigin: { louise: 1, compose: 2 },
    });
    expect(status.board.byState.candidate).toBe(1);
    expect(status.board.byState.draft_ready).toBe(1);
    expect(status.board.byState.needs_attention).toBe(1);
    expect(status.processing.staleRunning).toBe(1);
    expect(status.composeConversion.retryable).toBe(3);
    expect(status.composeControlPlane.turns.durableQueued).toBe(4);
    expect(status.composeControlPlane.turns.durableRunning).toBe(4);
    expect(status.composeControlPlane.turns.durableAbandoned).toBe(3);
    expect(status.composeControlPlane.turns.legacyInflight).toBe(2);
    expect(status.composeControlPlane.turns.legacyQueued).toBe(1);
    expect(status.composeControlPlane.turns.leaseExpired).toBe(2);
    expect(status.composeControlPlane.turns.leaseFenceRejected).toBe(5);
    expect(status.composeControlPlane.agentTasks.queued).toBe(5);
    expect(status.composeControlPlane.agentTasks.leaseExpired).toBe(1);
    expect(status.composeControlPlane.agentTasks.leaseFenceRejected).toBe(4);
    expect(status.composeControlPlane.llm.callsToday).toBe(9);
    expect(status.composeControlPlane.llm.failedToday).toBe(2);
    expect(status.composeControlPlane.llm.estimatedCostUsdToday).toBe(1.75);
    expect(status.composeControlPlane.workers.live).toBe(2);
    expect(status.composeControlPlane.workers.stale).toBe(1);
    expect(status.composeControlPlane.workers.byMode.worker.stale).toBe(1);
    expect(deps.repository.getProcessingJobHealth).toHaveBeenCalledWith({
      staleStartedBefore: expect.any(Date),
    });
  });

  it("listSourceEvents requires the source and returns its timeline", async () => {
    const deps = makeDeps();
    const events = [
      {
        id: 701,
        sourceId: 12,
        eventType: "draft_generation_queued",
        actor: "kkompalli",
        metadata: { jobId: 44 },
        createdAt: "2026-06-01T12:01:00.000Z",
      },
    ];
    deps.repository.getSourceById.mockResolvedValueOnce(sourceSummary());
    deps.repository.listSourceEvents.mockResolvedValueOnce(events);

    await expect(deps.service.listSourceEvents(12)).resolves.toBe(events);
    expect(deps.repository.listSourceEvents).toHaveBeenCalledWith(12);
  });

  it("listSourceEvents rejects missing sources", async () => {
    const deps = makeDeps();
    deps.repository.getSourceById.mockResolvedValueOnce(null);

    await expect(deps.service.listSourceEvents(404)).rejects.toThrow(
      "Spec Factory source 404 was not found",
    );
    expect(deps.repository.listSourceEvents).not.toHaveBeenCalled();
  });

  it("listSourceAttachments requires the source and returns attachment archive rows", async () => {
    const deps = makeDeps();
    const attachments = [
      {
        id: 301,
        sourceId: 12,
        jiraAttachmentId: "att-1",
        filename: "Development-Plan.md",
        mimeType: "text/markdown",
        sizeBytes: 2400,
        artifactKind: "code-change",
        isPriority: true,
        s3Bucket: "specter-results",
        s3Key: "spec-factory/CPDEV-22410/attachments/att-1-Development-Plan.md",
        sha256: "a".repeat(64),
        extractedText: "Implementation notes",
        extractionStatus: "extracted" as const,
        errorMessage: null,
        createdAt: "2026-06-01T12:00:00.000Z",
        updatedAt: "2026-06-01T12:01:00.000Z",
      },
    ];
    deps.repository.getSourceById.mockResolvedValueOnce(sourceSummary());
    deps.repository.listSourceAttachments.mockResolvedValueOnce(attachments);

    await expect(deps.service.listSourceAttachments(12)).resolves.toBe(
      attachments,
    );
    expect(deps.repository.listSourceAttachments).toHaveBeenCalledWith(12);
  });

  it("listSourceAttachments rejects missing sources", async () => {
    const deps = makeDeps();
    deps.repository.getSourceById.mockResolvedValueOnce(null);

    await expect(deps.service.listSourceAttachments(404)).rejects.toThrow(
      "Spec Factory source 404 was not found",
    );
    expect(deps.repository.listSourceAttachments).not.toHaveBeenCalled();
  });

  it("retrySourceAttachments re-archives Louise evidence and records retry counts", async () => {
    const deps = makeDeps();
    const failedAttachment = {
      id: 301,
      sourceId: 12,
      jiraAttachmentId: "att-1",
      filename: "Development-Plan.md",
      mimeType: "text/markdown",
      sizeBytes: 2400,
      artifactKind: "code-change",
      isPriority: true,
      s3Bucket: null,
      s3Key: null,
      sha256: null,
      extractedText: null,
      extractionStatus: "failed" as const,
      errorMessage: "download failed",
      createdAt: "2026-06-01T12:00:00.000Z",
      updatedAt: "2026-06-01T12:01:00.000Z",
    };
    const resolvedAttachment = {
      ...failedAttachment,
      s3Bucket: "specter-results",
      s3Key: "spec-factory/CPDEV-22410/attachments/att-1-Development-Plan.md",
      extractedText: "Implementation notes",
      extractionStatus: "extracted" as const,
      errorMessage: null,
    };
    deps.repository.getSourceById.mockResolvedValueOnce(sourceSummary());
    deps.repository.listSourceAttachments
      .mockResolvedValueOnce([failedAttachment])
      .mockResolvedValueOnce([resolvedAttachment]);
    deps.evidenceCollector.collect.mockResolvedValueOnce({
      sourceJiraKey: "CPDEV-22410",
      warnings: [],
      snapshotId: 501,
    });

    await expect(
      deps.service.retrySourceAttachments({
        sourceId: 12,
        actor: "kkompalli",
      }),
    ).resolves.toMatchObject({
      attachments: [resolvedAttachment],
      retriedCount: 1,
      beforeAttentionCount: 1,
      afterAttentionCount: 0,
    });

    expect(deps.evidenceCollector.collect).toHaveBeenCalledWith(12);
    expect(deps.repository.recordEvent).toHaveBeenCalledWith(
      12,
      "attachment_archive_retried",
      "kkompalli",
      expect.objectContaining({
        retriedCount: 1,
        beforeAttentionCount: 1,
        afterAttentionCount: 0,
        retriedAttachmentIds: ["att-1"],
        snapshotId: 501,
      }),
    );
  });

  it("retrySourceAttachments rejects Compose sources", async () => {
    const deps = makeDeps();
    deps.repository.getSourceById.mockResolvedValueOnce(
      sourceSummary({ origin: "compose", sourceJiraKey: "COMPOSE-7" }),
    );

    await expect(
      deps.service.retrySourceAttachments({
        sourceId: 12,
        actor: "kkompalli",
      }),
    ).rejects.toThrow(/only supported for Louise/i);
    expect(deps.evidenceCollector.collect).not.toHaveBeenCalled();
    expect(deps.repository.listSourceAttachments).not.toHaveBeenCalled();
  });

  it("restoreSource restores an archived source and records an audit event", async () => {
    const deps = makeDeps();
    const archived = sourceSummary({ state: "archived" });
    const restored = sourceSummary({ state: "draft_ready" });
    deps.repository.getSourceById
      .mockResolvedValueOnce(archived)
      .mockResolvedValueOnce(restored);
    deps.repository.restoreArchivedSource.mockResolvedValueOnce(true);

    await expect(
      deps.service.restoreSource({ sourceId: 12, actor: "kkompalli" }),
    ).resolves.toBe(restored);

    expect(deps.repository.restoreArchivedSource).toHaveBeenCalledWith(12);
    expect(deps.repository.recordEvent).toHaveBeenCalledWith(
      12,
      "source_restored",
      "kkompalli",
      { sourceId: 12 },
    );
  });

  it("restoreSource rejects sources that are not archived", async () => {
    const deps = makeDeps();
    deps.repository.getSourceById.mockResolvedValueOnce(sourceSummary());
    deps.repository.restoreArchivedSource.mockResolvedValueOnce(false);

    await expect(
      deps.service.restoreSource({ sourceId: 12, actor: "kkompalli" }),
    ).rejects.toThrow(/not archived/i);
  });

  it("requestLouiseBoardRefresh starts a background Jira refresh when forced", async () => {
    const deps = makeDeps();
    const sources = [sourceSummary()];
    let releaseRefresh: (() => void) | undefined;
    deps.repository.getLatestIntakeRefreshAt.mockResolvedValueOnce(
      new Date().toISOString(),
    );
    deps.repository.listLouiseBoardSources.mockResolvedValueOnce(sources);
    deps.ingestor.refresh.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseRefresh = () =>
          resolve({
            scanned: 2,
            upserted: 2,
            matched: 2,
            truncated: false,
            claimed: 2,
            claimFailures: 0,
            newSources: [],
          });
      }),
    );

    await expect(
      deps.service.requestLouiseBoardRefresh({ force: true }),
    ).resolves.toMatchObject({
      refresh: { status: "started", reason: "manual_force" },
      sources,
    });
    expect(deps.ingestor.refresh).toHaveBeenCalledTimes(1);
    releaseRefresh?.();
  });

  it("queues draft generation only for newly intaken tickets", async () => {
    const deps = makeDeps();
    const sources = [sourceSummary({ id: 21, sourceJiraKey: "CPDEV-22500" })];
    deps.ingestor.refresh.mockResolvedValueOnce({
      scanned: 2,
      upserted: 1,
      matched: 2,
      truncated: false,
      claimed: 1,
      claimFailures: 0,
      newSources: [{ id: 21, key: "CPDEV-22500" }],
    });
    deps.repository.listLouiseBoardSources.mockResolvedValueOnce(sources);
    deps.repository.createProcessingJob.mockResolvedValueOnce(701);

    await expect(deps.service.refreshLouiseBoard()).resolves.toEqual({
      refresh: {
        status: "completed",
        scanned: 2,
        upserted: 1,
        matched: 2,
        truncated: false,
        claimed: 1,
        claimFailures: 0,
        autoQueued: 1,
      },
      sources,
    });

    expect(deps.repository.markSourceDrafting).toHaveBeenCalledWith(21);
    expect(deps.repository.createProcessingJob).toHaveBeenCalledWith({
      sourceId: 21,
      jobType: "draft_generation",
      requestedBy: "spec-factory-intake",
    });
    expect(deps.repository.recordEvent).toHaveBeenCalledWith(
      21,
      "draft_generation_auto_queued",
      expect.any(String),
      { jobId: 701, sourceJiraKey: "CPDEV-22500" },
    );
    expect(deps.repository.recordIntakeRefresh).toHaveBeenCalledWith({
      status: "succeeded",
      scanned: 2,
      inserted: 1,
      matched: 2,
      claimed: 1,
      claimFailures: 0,
      autoQueued: 1,
    });
  });

  it("expires stale draft-generation jobs before manual regeneration", async () => {
    const deps = makeDeps();
    deps.repository.getSourceById
      .mockResolvedValueOnce(sourceSummary())
      .mockResolvedValueOnce(sourceSummary({ state: "drafting" }));
    deps.repository.createProcessingJob.mockResolvedValueOnce(701);
    deps.repository.getLatestDraft.mockResolvedValueOnce(null);

    await expect(
      deps.service.requestDraftGeneration({
        sourceId: 12,
        actor: "spec-factory-operator",
      }),
    ).resolves.toMatchObject({ queued: true });

    expect(deps.repository.expireStaleProcessingJobs).toHaveBeenCalledWith(
      expect.objectContaining({
        jobType: "draft_generation",
        staleStartedBefore: expect.any(Date),
      }),
    );
    expect(deps.repository.createProcessingJob).toHaveBeenCalledWith({
      sourceId: 12,
      jobType: "draft_generation",
      requestedBy: "spec-factory-operator",
    });
  });

  it("reuses an approved draft for context repair instead of regenerating it", async () => {
    const deps = makeDeps();
    const source = sourceSummary({
      state: "approved",
      approvedEpicKey: "CPDEV-9",
    });
    const approvedDraft = draftDetail({ status: "approved" });
    deps.repository.getSourceById.mockResolvedValueOnce(source);
    deps.repository.getLatestDraft.mockResolvedValueOnce(approvedDraft);

    await expect(
      deps.service.requestDraftGeneration({
        sourceId: 12,
        actor: "context-v4-backfill",
        reuseExistingDraft: true,
      }),
    ).resolves.toEqual({ queued: false, source, draft: approvedDraft });

    expect(deps.repository.markSourceDrafting).not.toHaveBeenCalled();
    expect(deps.repository.createProcessingJob).not.toHaveBeenCalled();
    expect(deps.repository.createDraftWorkflow).not.toHaveBeenCalled();
    expect(deps.repository.recordEvent).toHaveBeenCalledWith(
      12,
      "draft_generation_reused",
      "context-v4-backfill",
      expect.objectContaining({ draftStatus: "approved" }),
    );
  });

  it("ages out queued jobs whose worker died (startup sweep + periodic loop)", async () => {
    const deps = makeDeps();

    // Drive a single processing-loop pass with no claimable job so we can
    // assert sweepers fired before claimNextProcessingJob.
    deps.repository.claimNextProcessingJob.mockResolvedValueOnce(null);

    await (
      deps.service as unknown as {
        processQueuedJobs(): Promise<void>;
      }
    ).processQueuedJobs();

    expect(deps.repository.expireStaleProcessingJobs).toHaveBeenCalledWith(
      expect.objectContaining({
        jobType: "draft_generation",
        staleStartedBefore: expect.any(Date),
      }),
    );
    expect(
      deps.repository.expireStaleQueuedProcessingJobs,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        jobType: "draft_generation",
        queuedBefore: expect.any(Date),
        errorMessage: expect.stringMatching(/queued/i),
      }),
    );
  });

  it("startProcessingLoop fires the queued-age-out sweep on startup", async () => {
    const deps = makeDeps();

    deps.service.startProcessingLoop();
    // immediate kickProcessing happens inside startProcessingLoop; allow
    // the pending microtasks to run.
    await new Promise((resolve) => setImmediate(resolve));
    deps.service.stopProcessingLoop();

    expect(
      deps.repository.expireStaleQueuedProcessingJobs,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        jobType: "draft_generation",
        queuedBefore: expect.any(Date),
      }),
    );
  });

  it("blocks manual draft generation when priority attachments need attention", async () => {
    const deps = makeDeps();
    deps.repository.getSourceById.mockResolvedValueOnce(sourceSummary());
    deps.repository.listSourceAttachments.mockResolvedValueOnce([
      {
        id: 301,
        sourceId: 12,
        jiraAttachmentId: "att-1",
        filename: "Development-Plan.md",
        mimeType: "text/markdown",
        sizeBytes: 2400,
        artifactKind: "code-change",
        isPriority: true,
        s3Bucket: null,
        s3Key: null,
        sha256: null,
        extractedText: null,
        extractionStatus: "failed" as const,
        errorMessage: "download failed",
        createdAt: "2026-06-01T12:00:00.000Z",
        updatedAt: "2026-06-01T12:01:00.000Z",
      },
    ]);

    await expect(
      deps.service.requestDraftGeneration({
        sourceId: 12,
        actor: "spec-factory-operator",
      }),
    ).rejects.toThrow(
      /Retry priority attachments before generating a draft: Development-Plan\.md \(failed\)/,
    );

    expect(deps.repository.markSourceDrafting).not.toHaveBeenCalled();
    expect(deps.repository.createProcessingJob).not.toHaveBeenCalled();
  });

  it("allows manual draft generation when only non-priority attachments need attention", async () => {
    const deps = makeDeps();
    deps.repository.getSourceById
      .mockResolvedValueOnce(sourceSummary())
      .mockResolvedValueOnce(sourceSummary({ state: "drafting" }));
    deps.repository.listSourceAttachments.mockResolvedValueOnce([
      {
        id: 302,
        sourceId: 12,
        jiraAttachmentId: "att-2",
        filename: "Architecture.png",
        mimeType: "image/png",
        sizeBytes: 9000,
        artifactKind: "screenshot",
        isPriority: false,
        s3Bucket: null,
        s3Key: null,
        sha256: null,
        extractedText: null,
        extractionStatus: "failed" as const,
        errorMessage: "download failed",
        createdAt: "2026-06-01T12:00:00.000Z",
        updatedAt: "2026-06-01T12:01:00.000Z",
      },
    ]);
    deps.repository.createProcessingJob.mockResolvedValueOnce(701);
    deps.repository.getLatestDraft.mockResolvedValueOnce(null);

    await expect(
      deps.service.requestDraftGeneration({
        sourceId: 12,
        actor: "spec-factory-operator",
      }),
    ).resolves.toMatchObject({ queued: true });

    expect(deps.repository.createProcessingJob).toHaveBeenCalledWith({
      sourceId: 12,
      jobType: "draft_generation",
      requestedBy: "spec-factory-operator",
    });
  });

  it("generateDraft marks a source needs-attention when priority attachments block generation", async () => {
    const deps = makeDeps();
    deps.repository.getSourceById.mockResolvedValueOnce(sourceSummary());
    deps.repository.listSourceAttachments.mockResolvedValueOnce([
      {
        id: 301,
        sourceId: 12,
        jiraAttachmentId: "att-1",
        filename: "Development-Plan.md",
        mimeType: "text/markdown",
        sizeBytes: 2400,
        artifactKind: "code-change",
        isPriority: true,
        s3Bucket: null,
        s3Key: null,
        sha256: null,
        extractedText: null,
        extractionStatus: "unsupported" as const,
        errorMessage: "unsupported file",
        createdAt: "2026-06-01T12:00:00.000Z",
        updatedAt: "2026-06-01T12:01:00.000Z",
      },
    ]);

    await expect(deps.service.generateDraft({ sourceId: 12 })).rejects.toThrow(
      /Retry priority attachments before generating a draft: Development-Plan\.md \(unsupported\)/,
    );

    expect(deps.repository.markSourceDrafting).not.toHaveBeenCalled();
    expect(deps.evidenceCollector.collect).not.toHaveBeenCalled();
    expect(deps.repository.markDraftGenerationFailed).toHaveBeenCalledWith({
      sourceId: 12,
      stateWithoutReadyDraft: "needs_attention",
      reasons: ["generation_failed"],
      errorMessage: expect.stringContaining("Retry priority attachments"),
    });
    expect(deps.repository.markSourceNotQualified).not.toHaveBeenCalled();
  });

  it("generateDraft collects evidence and repo context before creating the next draft", async () => {
    const deps = makeDeps();
    const evidenceManifest = {
      sourceJiraKey: "CPDEV-22410",
      descriptionMarkdown: "Requirement text",
      comments: [],
      artifacts: [],
      warnings: [],
    };
    const context = repoContext();
    const evidenceWorkspace = taskWorkspace({ repoLinks: [] });
    const workspace = taskWorkspace({
      repoLinks: [
        {
          repoName: "core-app",
          workspacePath: "/tmp/core-app",
          linkPath: "/tmp/spec-factory/tasks/12/repos/core-app",
          linked: true,
        },
      ],
    });
    const generated = {
      bundle: validBundle(),
      renderedMarkdown: "# Draft",
      validation: {
        valid: true,
        normalized: validBundle(),
        errors: [],
        warnings: [],
      },
      modelMetadata: { provider: "bedrock", model: "claude", metrics: {} },
    };
    const latest = draftDetail();

    deps.repository.getSourceById.mockResolvedValueOnce(sourceSummary());
    deps.evidenceCollector.collect.mockResolvedValueOnce(evidenceManifest);
    deps.repoContextCollector.collect.mockResolvedValueOnce(context);
    deps.evidenceWorkspaceManager.prepare
      .mockResolvedValueOnce(evidenceWorkspace)
      .mockResolvedValueOnce(workspace);
    deps.generator.generate.mockResolvedValueOnce(generated);
    deps.repository.createDraft.mockResolvedValueOnce(44);
    deps.repository.getLatestDraft.mockResolvedValueOnce(latest);

    await expect(deps.service.generateDraft({ sourceId: 12 })).resolves.toBe(
      latest,
    );

    expect(deps.repository.markSourceDrafting).toHaveBeenCalledWith(12);
    expect(deps.evidenceCollector.collect).toHaveBeenCalledWith(12);
    expect(deps.evidenceWorkspaceManager.prepare).toHaveBeenNthCalledWith(1, {
      sourceId: 12,
      evidenceManifest,
      repoContextManifest: null,
    });
    expect(deps.qualifier.qualify).toHaveBeenCalledWith({
      sourceId: 12,
      sourceJiraKey: "CPDEV-22410",
      evidenceManifest,
      taskWorkspace: evidenceWorkspace,
    });
    expect(deps.repoContextCollector.collect).toHaveBeenCalledWith({
      sourceId: 12,
      evidenceManifest,
      qualification: qualificationDecision(),
    });
    expect(deps.evidenceWorkspaceManager.prepare).toHaveBeenNthCalledWith(2, {
      sourceId: 12,
      evidenceManifest,
      repoContextManifest: context,
    });
    expect(deps.generator.generate).toHaveBeenCalledWith({
      sourceId: 12,
      sourceJiraKey: "CPDEV-22410",
      repoIds: ["spec-factory-task-12", "7"],
      evidenceManifest,
      repoContextManifest: context,
      taskWorkspace: workspace,
    });
    expect(deps.repository.createDraft).toHaveBeenCalledWith({
      sourceId: 12,
      version: 3,
      evidenceSnapshotId: null,
      bundle: generated.bundle,
      renderedMarkdown: "# Draft",
      evidenceManifest: {
        evidenceManifest,
        qualification: qualificationDecision(),
        repoContextManifest: context,
        repoDeepDiveEnabled: true,
        taskWorkspace: workspace,
      },
      modelMetadata: generated.modelMetadata,
    });
  });

  it("generateDraft cleans repo worktrees after the generator is done", async () => {
    const deps = makeDeps();
    const cleanup = vi.fn();
    const baseContext = repoContext();
    const context = repoContext({
      repos: [{ ...baseContext.repos[0], cleanup }],
    });
    const evidenceManifest = {
      sourceJiraKey: "CPDEV-22410",
      descriptionMarkdown: "Requirement text",
      comments: [],
      artifacts: [],
      warnings: [],
    };
    const workspace = taskWorkspace();
    const generated = {
      bundle: validBundle(),
      renderedMarkdown: "# Draft",
      validation: {
        valid: true,
        normalized: validBundle(),
        errors: [],
        warnings: [],
      },
      modelMetadata: { provider: "bedrock", model: "claude", metrics: {} },
    };

    deps.repository.getSourceById.mockResolvedValueOnce(sourceSummary());
    deps.evidenceCollector.collect.mockResolvedValueOnce(evidenceManifest);
    deps.repoContextCollector.collect.mockResolvedValueOnce(context);
    deps.evidenceWorkspaceManager.prepare
      .mockResolvedValueOnce(taskWorkspace({ repoLinks: [] }))
      .mockResolvedValueOnce(workspace);
    deps.generator.generate.mockResolvedValueOnce(generated);
    deps.repository.createDraft.mockResolvedValueOnce(44);
    deps.repository.getLatestDraft.mockResolvedValueOnce(draftDetail());

    await deps.service.generateDraft({ sourceId: 12 });

    expect(deps.generator.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        repoContextManifest: expect.objectContaining({
          repos: [expect.not.objectContaining({ cleanup })],
        }),
      }),
    );
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(deps.repository.recordEvent).toHaveBeenCalledWith(
      12,
      "repo_workspace_cleanup_completed",
      expect.any(String),
      { cleaned: ["core-app"], failed: [] },
    );
  });

  it("does not mark a ticket config-only when development evidence is present", async () => {
    const deps = makeDeps();
    const evidenceManifest = {
      sourceJiraKey: "CPDEV-22410",
      descriptionMarkdown:
        "Retarus fax delivery needs implementation work in core-app.",
      comments: [],
      artifacts: [
        {
          kind: "config_changes",
          filename: "Configuration-Plan-CPDEV-22410.md",
          content:
            "Configuration plan notes: no code changes in this config section.",
          isPriority: true,
          extractionStatus: "extracted",
        },
        {
          kind: "code_changes",
          filename: "Development-Plan-CPDEV-22410.md",
          content:
            "Implementation details: update RetarusFaxService.java, add API handling, and cover the service with integration tests.",
          isPriority: true,
          extractionStatus: "extracted",
        },
      ],
      warnings: [],
      repoReferences: {
        matchedRepos: [
          {
            repoId: 7,
            repoName: "core-app",
            repoUrl: "https://github.com/mhk-repos/core-app.git",
            defaultBranch: "master",
            evidenceRefs: ["attachment:Development-Plan-CPDEV-22410.md"],
          },
        ],
        unresolvedHints: [],
        warnings: [],
      },
    };
    const context = repoContext();
    const evidenceWorkspace = taskWorkspace({ repoLinks: [] });
    const workspace = taskWorkspace();
    const generated = {
      bundle: validBundle(),
      renderedMarkdown: "# Draft",
      validation: {
        valid: true,
        normalized: validBundle(),
        errors: [],
        warnings: [],
      },
      modelMetadata: { provider: "bedrock", model: "claude", metrics: {} },
    };
    const latest = draftDetail();

    deps.repository.getSourceById.mockResolvedValueOnce(sourceSummary());
    deps.evidenceCollector.collect.mockResolvedValueOnce(evidenceManifest);
    deps.qualifier.qualify.mockResolvedValueOnce(
      qualificationDecision({
        summary: "Development-Plan evidence describes service implementation.",
      }),
    );
    deps.repoContextCollector.collect.mockResolvedValueOnce(context);
    deps.evidenceWorkspaceManager.prepare
      .mockResolvedValueOnce(evidenceWorkspace)
      .mockResolvedValueOnce(workspace);
    deps.generator.generate.mockResolvedValueOnce(generated);
    deps.repository.createDraft.mockResolvedValueOnce(44);
    deps.repository.getLatestDraft.mockResolvedValueOnce(latest);

    await expect(deps.service.generateDraft({ sourceId: 12 })).resolves.toBe(
      latest,
    );

    expect(deps.repository.markSourceNotQualified).not.toHaveBeenCalled();
    expect(deps.qualifier.qualify).toHaveBeenCalledWith(
      expect.objectContaining({ taskWorkspace: evidenceWorkspace }),
    );
    expect(deps.repoContextCollector.collect).toHaveBeenCalledWith({
      sourceId: 12,
      evidenceManifest,
      qualification: expect.objectContaining({
        summary: "Development-Plan evidence describes service implementation.",
      }),
    });
    expect(deps.generator.generate).toHaveBeenCalled();
  });

  it("marks explicit configuration-only tickets config-only when no development evidence is present", async () => {
    const deps = makeDeps();
    const evidenceManifest = {
      sourceJiraKey: "CPDEV-22410",
      descriptionMarkdown: "Configuration-only request for client defaults.",
      comments: [],
      artifacts: [
        {
          kind: "config_changes",
          filename: "Configuration-Plan-CPDEV-22410.md",
          content:
            "Config-only update. No code changes required; update client configuration values and validate rollout.",
          isPriority: true,
          extractionStatus: "extracted",
        },
      ],
      warnings: [],
      repoReferences: {
        matchedRepos: [
          {
            repoId: 7,
            repoName: "core-app",
            repoUrl: "https://github.com/mhk-repos/core-app.git",
            defaultBranch: "master",
            evidenceRefs: ["attachment:Configuration-Plan-CPDEV-22410.md"],
          },
        ],
        unresolvedHints: [],
        warnings: [],
      },
    };

    deps.repository.getSourceById.mockResolvedValueOnce(sourceSummary());
    deps.evidenceCollector.collect.mockResolvedValueOnce(evidenceManifest);
    deps.evidenceWorkspaceManager.prepare.mockResolvedValueOnce(
      taskWorkspace(),
    );
    deps.qualifier.qualify.mockResolvedValueOnce(
      qualificationDecision({
        qualified: false,
        reasons: ["config_only"],
        confidence: "high",
        summary: "The evidence describes configuration-only work.",
        evidenceRefs: ["attachment:Configuration-Plan-CPDEV-22410.md"],
        repoHints: [],
      }),
    );

    await expect(
      deps.service.generateDraft({ sourceId: 12 }),
    ).resolves.toBeNull();

    expect(deps.repoContextCollector.collect).not.toHaveBeenCalled();
    expect(deps.generator.generate).not.toHaveBeenCalled();
    expect(deps.repository.markSourceNotQualified).toHaveBeenCalledWith(
      12,
      ["config_only"],
      "The evidence describes configuration-only work.",
    );
  });

  it("generateDraft uses an evidence workspace when repo deep-dive is disabled", async () => {
    const deps = makeDeps();
    const service = new SpecFactoryService(
      deps.repository as any,
      deps.ingestor,
      deps.evidenceCollector,
      deps.repoContextCollector,
      deps.generator,
      deps.publisher,
      deps.submitter,
      deps.evidenceWorkspaceManager,
      { repoDeepDiveEnabled: false, qualifier: deps.qualifier },
    );
    const evidenceManifest = {
      sourceJiraKey: "CPDEV-22410",
      snapshotId: 501,
      descriptionMarkdown: "Requirement text",
      comments: [],
      artifacts: [],
      warnings: [],
      repoReferences: {
        matchedRepos: [
          {
            repoId: 7,
            repoName: "core-app",
            repoUrl: "https://github.com/mhk-repos/core-app.git",
            defaultBranch: "master",
            evidenceRefs: ["attachment:Development-Plan-CPDEV-22410.md"],
          },
        ],
        unresolvedHints: [],
        warnings: [],
      },
    };
    const generated = {
      bundle: validBundle(),
      renderedMarkdown: "# Draft",
      validation: {
        valid: true,
        normalized: validBundle(),
        errors: [],
        warnings: [],
      },
      modelMetadata: { provider: "bedrock", model: "claude", metrics: {} },
    };
    const latest = draftDetail({ evidenceSnapshotId: 501 });

    deps.repository.getSourceById.mockResolvedValueOnce(sourceSummary());
    deps.evidenceCollector.collect.mockResolvedValueOnce(evidenceManifest);
    const workspace = taskWorkspace();
    deps.evidenceWorkspaceManager.prepare.mockResolvedValueOnce(workspace);
    deps.generator.generate.mockResolvedValueOnce(generated);
    deps.repository.createDraft.mockResolvedValueOnce(44);
    deps.repository.getLatestDraft.mockResolvedValueOnce(latest);

    await expect(service.generateDraft({ sourceId: 12 })).resolves.toBe(latest);

    expect(deps.repoContextCollector.collect).not.toHaveBeenCalled();
    expect(deps.evidenceWorkspaceManager.prepare).toHaveBeenCalledWith({
      sourceId: 12,
      evidenceManifest,
      repoContextManifest: null,
    });
    expect(deps.generator.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        repoIds: ["spec-factory-task-12"],
        repoContextManifest: undefined,
        taskWorkspace: workspace,
      }),
    );
    expect(deps.repository.createDraft).toHaveBeenCalledWith(
      expect.objectContaining({ evidenceSnapshotId: 501 }),
    );
  });

  it("generateDraft marks a ticket not qualified when the qualifier cannot infer a repo", async () => {
    const deps = makeDeps();
    const service = new SpecFactoryService(
      deps.repository as any,
      deps.ingestor,
      deps.evidenceCollector,
      deps.repoContextCollector,
      deps.generator,
      deps.publisher,
      deps.submitter,
      deps.evidenceWorkspaceManager,
      { repoDeepDiveEnabled: false, qualifier: deps.qualifier },
    );
    const evidenceManifest = {
      sourceJiraKey: "CPDEV-22410",
      descriptionMarkdown: "Requirement text",
      comments: [],
      artifacts: [],
      warnings: [],
      repoReferences: {
        matchedRepos: [],
        unresolvedHints: ["unknown-repo"],
        warnings: [
          "Repository hint could not be resolved against code_repositories: unknown-repo",
        ],
      },
    };

    deps.repository.getSourceById.mockResolvedValueOnce(sourceSummary());
    deps.evidenceCollector.collect.mockResolvedValueOnce(evidenceManifest);
    deps.evidenceWorkspaceManager.prepare.mockResolvedValueOnce(
      taskWorkspace(),
    );
    deps.qualifier.qualify.mockResolvedValueOnce(
      qualificationDecision({
        qualified: false,
        reasons: ["needs_repo"],
        confidence: "medium",
        summary: "Development work may exist, but no repo can be inferred.",
        repoHints: [],
      }),
    );

    await expect(service.generateDraft({ sourceId: 12 })).resolves.toBeNull();

    expect(deps.evidenceWorkspaceManager.prepare).toHaveBeenCalledWith({
      sourceId: 12,
      evidenceManifest,
      repoContextManifest: null,
    });
    expect(deps.generator.generate).not.toHaveBeenCalled();
    expect(deps.repository.markSourceNotQualified).toHaveBeenCalledWith(
      12,
      ["needs_repo"],
      "Development work may exist, but no repo can be inferred.",
    );
    expect(deps.repository.recordEvent).toHaveBeenCalledWith(
      12,
      "draft_generation_not_qualified",
      expect.any(String),
      expect.objectContaining({ reasons: ["needs_repo"] }),
    );
  });

  it("generateDraft marks the source not qualified when repo context has no repoIds", async () => {
    const deps = makeDeps();
    const evidenceManifest = {
      sourceJiraKey: "CPDEV-22410",
      descriptionMarkdown: "Requirement text",
      comments: [],
      artifacts: [],
      warnings: [],
    };
    deps.repository.getSourceById.mockResolvedValueOnce(sourceSummary());
    deps.evidenceCollector.collect.mockResolvedValueOnce(evidenceManifest);
    deps.evidenceWorkspaceManager.prepare.mockResolvedValueOnce(
      taskWorkspace(),
    );
    deps.repoContextCollector.collect.mockResolvedValueOnce(
      repoContext({ repos: [] }),
    );

    await expect(
      deps.service.generateDraft({ sourceId: 12 }),
    ).resolves.toBeNull();
    expect(deps.repository.markSourceNotQualified).toHaveBeenCalledWith(
      12,
      ["needs_repo"],
      expect.stringContaining(
        "requires at least one registered repo workspace",
      ),
    );
    expect(deps.generator.generate).not.toHaveBeenCalled();
  });

  it("generateDraft marks the source not qualified when generation fails", async () => {
    const deps = makeDeps();
    const evidenceManifest = {
      sourceJiraKey: "CPDEV-22410",
      descriptionMarkdown: "Requirement text",
      comments: [],
      artifacts: [],
      warnings: [],
    };
    deps.repository.getSourceById.mockResolvedValueOnce(sourceSummary());
    deps.evidenceCollector.collect.mockResolvedValueOnce(evidenceManifest);
    deps.repoContextCollector.collect.mockResolvedValueOnce(repoContext());
    deps.evidenceWorkspaceManager.prepare
      .mockResolvedValueOnce(taskWorkspace({ repoLinks: [] }))
      .mockResolvedValueOnce(taskWorkspace());
    deps.generator.generate.mockRejectedValueOnce(new Error("agent failed"));

    await expect(deps.service.generateDraft({ sourceId: 12 })).rejects.toThrow(
      "agent failed",
    );
    expect(deps.repository.markDraftGenerationFailed).toHaveBeenCalledWith({
      sourceId: 12,
      stateWithoutReadyDraft: "not_qualified",
      reasons: ["generation_failed"],
      errorMessage: "agent failed",
    });
  });

  it("uses the Jira evidence collector for louise-origin sources (characterization)", async () => {
    const deps = makeDeps();
    const evidenceManifest = {
      sourceJiraKey: "CPDEV-22410",
      descriptionMarkdown: "Requirement text",
      comments: [],
      artifacts: [],
      warnings: [],
    };
    const context = repoContext();
    const evidenceWorkspace = taskWorkspace({ repoLinks: [] });
    const workspace = taskWorkspace({
      repoLinks: [
        {
          repoName: "core-app",
          workspacePath: "/tmp/core-app",
          linkPath: "/tmp/spec-factory/tasks/12/repos/core-app",
          linked: true,
        },
      ],
    });
    const generated = {
      bundle: validBundle(),
      renderedMarkdown: "# Draft",
      validation: {
        valid: true,
        normalized: validBundle(),
        errors: [],
        warnings: [],
      },
      modelMetadata: { provider: "bedrock", model: "claude", metrics: {} },
    };
    const latest = draftDetail();

    deps.repository.getSourceById.mockResolvedValueOnce(sourceSummary());
    deps.repository.getSourceOrigin.mockResolvedValue("louise");
    deps.evidenceCollector.collect.mockResolvedValueOnce(evidenceManifest);
    deps.repoContextCollector.collect.mockResolvedValueOnce(context);
    deps.evidenceWorkspaceManager.prepare
      .mockResolvedValueOnce(evidenceWorkspace)
      .mockResolvedValueOnce(workspace);
    deps.generator.generate.mockResolvedValueOnce(generated);
    deps.repository.createDraft.mockResolvedValueOnce(44);
    deps.repository.getLatestDraft.mockResolvedValueOnce(latest);

    await deps.service.generateDraft({ sourceId: 12 });
    expect(deps.evidenceCollector.collect).toHaveBeenCalledWith(12);
    expect(deps.composeEvidenceProvider.collect).not.toHaveBeenCalled();
    expect(deps.repository.createDraft).toHaveBeenCalledTimes(1);
  });

  it("uses the compose provider and skips reject for compose-origin sources", async () => {
    const deps = makeDeps();
    const evidenceManifest = {
      sourceJiraKey: "COMPOSE-2",
      descriptionMarkdown: "Requirement text",
      comments: [],
      artifacts: [],
      warnings: [],
    };
    const context = repoContext({
      sourceJiraKey: "COMPOSE-2",
      repos: [
        {
          repoName: "core-app",
          repoId: "7",
          branch: "master",
          headSha: "abc123",
          workspacePath: "/tmp/core-app",
          inspectedPaths: ["service/Validator.java"],
          evidenceRefs: ["attachment:loe.md"],
          summaries: [],
          warnings: [],
        },
      ],
    });
    const evidenceWorkspace = taskWorkspace({ repoLinks: [] });
    const workspace = taskWorkspace({
      repoLinks: [
        {
          repoName: "core-app",
          workspacePath: "/tmp/core-app",
          linkPath: "/tmp/spec-factory/tasks/12/repos/core-app",
          linked: true,
        },
      ],
    });
    const generated = {
      bundle: validBundle(),
      renderedMarkdown: "# Draft",
      validation: {
        valid: true,
        normalized: validBundle(),
        errors: [],
        warnings: [],
      },
      modelMetadata: { provider: "bedrock", model: "claude", metrics: {} },
    };
    const latest = draftDetail();

    deps.repository.getSourceOrigin.mockResolvedValue("compose");
    deps.repository.getSourceById.mockResolvedValueOnce(
      sourceSummary({ id: 2, sourceJiraKey: "COMPOSE-2" }),
    );
    deps.composeEvidenceProvider.collect.mockResolvedValueOnce(
      evidenceManifest,
    );
    deps.repoContextCollector.collect.mockResolvedValueOnce(context);
    deps.evidenceWorkspaceManager.prepare
      .mockResolvedValueOnce(evidenceWorkspace)
      .mockResolvedValueOnce(workspace);
    deps.qualifier.qualify.mockResolvedValueOnce(
      qualificationDecision({
        qualified: false,
        reasons: ["needs_information"],
      }),
    );
    deps.generator.generate.mockResolvedValueOnce(generated);
    deps.repository.createDraft.mockResolvedValueOnce(44);
    deps.repository.getLatestDraft.mockResolvedValueOnce(latest);

    await deps.service.generateDraft({ sourceId: 2 });
    expect(deps.composeEvidenceProvider.collect).toHaveBeenCalledWith(2);
    expect(deps.repository.markSourceNotQualified).not.toHaveBeenCalled();
    expect(deps.repository.createDraft).toHaveBeenCalledTimes(1);
  });

  it("rejects a compose source when no compose evidence provider is configured", async () => {
    const deps = makeDeps();
    const service = new SpecFactoryService(
      deps.repository as any,
      deps.ingestor,
      deps.evidenceCollector,
      deps.repoContextCollector,
      deps.generator,
      deps.publisher,
      deps.submitter,
      deps.evidenceWorkspaceManager,
      { repoDeepDiveEnabled: true, qualifier: deps.qualifier },
    );
    deps.repository.getSourceOrigin.mockResolvedValue("compose");
    deps.repository.getSourceById.mockResolvedValueOnce(
      sourceSummary({ id: 2, sourceJiraKey: "COMPOSE-2" }),
    );

    await expect(service.generateDraft({ sourceId: 2 })).rejects.toThrow(
      /composeEvidenceProvider/,
    );
    expect(deps.evidenceCollector.collect).not.toHaveBeenCalled();
  });

  it("generateDraft marks SDK timeouts as needs attention instead of not qualified", async () => {
    const deps = makeDeps();
    const evidenceManifest = {
      sourceJiraKey: "CPDEV-22410",
      descriptionMarkdown: "Requirement text",
      comments: [],
      artifacts: [],
      warnings: [],
    };
    deps.repository.getSourceById.mockResolvedValueOnce(sourceSummary());
    deps.evidenceCollector.collect.mockResolvedValueOnce(evidenceManifest);
    deps.repoContextCollector.collect.mockResolvedValueOnce(repoContext());
    deps.evidenceWorkspaceManager.prepare
      .mockResolvedValueOnce(taskWorkspace({ repoLinks: [] }))
      .mockResolvedValueOnce(taskWorkspace());
    deps.generator.generate.mockRejectedValueOnce(
      new Error("SDK timeout after 600000ms"),
    );

    await expect(deps.service.generateDraft({ sourceId: 12 })).rejects.toThrow(
      "SDK timeout after 600000ms",
    );
    expect(deps.repository.markDraftGenerationFailed).toHaveBeenCalledWith({
      sourceId: 12,
      stateWithoutReadyDraft: "needs_attention",
      reasons: ["generation_failed"],
      errorMessage: "SDK timeout after 600000ms",
    });
    expect(deps.repository.markSourceNotQualified).not.toHaveBeenCalledWith(
      12,
      ["generation_failed"],
      "SDK timeout after 600000ms",
    );
  });

  it("approveDraft publishes only the latest draft and records created children", async () => {
    const deps = makeDeps();
    const latest = draftDetail();
    const approved = draftDetail({ status: "approved" });
    deps.repository.getSourceById.mockResolvedValueOnce(sourceSummary());
    deps.repository.getLatestDraft
      .mockResolvedValueOnce(latest)
      .mockResolvedValueOnce(approved);
    deps.publisher.approveDraft.mockImplementationOnce(
      async (_draft, options) => {
        await options.onEpicCreated("CPDEV-22411");
        await options.onChildCreated({
          childId: 99,
          jiraKey: "CPDEV-22412",
        });
        return {
          epicKey: "CPDEV-22411",
          children: [{ childId: 99, jiraKey: "CPDEV-22412" }],
        };
      },
    );

    await expect(
      deps.service.approveDraft({
        sourceId: 12,
        draftId: 44,
        actor: "kkompalli",
      }),
    ).resolves.toBe(approved);

    expect(deps.publisher.approveDraft).toHaveBeenCalledWith(
      latest,
      expect.objectContaining({
        onEpicCreated: expect.any(Function),
        onChildCreated: expect.any(Function),
      }),
    );
    expect(deps.repository.markDraftApproved).toHaveBeenCalledWith(
      44,
      "kkompalli",
    );
    expect(deps.repository.updateSourceApproved).toHaveBeenCalledWith(
      12,
      "CPDEV-22411",
    );
    expect(deps.repository.updateChildCreated).toHaveBeenCalledWith(
      99,
      "CPDEV-22412",
    );
    expect(deps.repository.recordEvent).toHaveBeenCalledWith(
      12,
      "draft_publish_started",
      "kkompalli",
      expect.objectContaining({
        draftId: 44,
        pendingChildCount: 1,
        retry: false,
      }),
    );
    expect(deps.repository.recordEvent).toHaveBeenCalledWith(
      12,
      "draft_publish_epic_created",
      "kkompalli",
      { draftId: 44, epicKey: "CPDEV-22411" },
    );
    expect(deps.repository.recordEvent).toHaveBeenCalledWith(
      12,
      "draft_publish_child_created",
      "kkompalli",
      { draftId: 44, childId: 99, jiraKey: "CPDEV-22412" },
    );
    expect(deps.repository.recordEvent).toHaveBeenCalledWith(
      12,
      "draft_publish_completed",
      "kkompalli",
      expect.objectContaining({ draftId: 44, epicKey: "CPDEV-22411" }),
    );
    expect(deps.repository.recordEvent).toHaveBeenCalledWith(
      12,
      "draft_approved",
      "kkompalli",
      expect.objectContaining({ draftId: 44, epicKey: "CPDEV-22411" }),
    );
  });

  it("updateDraft validates, versions, renders, and records an operator edit", async () => {
    const deps = makeDeps();
    const latest = draftDetail({ id: 44, version: 3 });
    const editedBundle = {
      ...validBundle(),
      epic: {
        ...validBundle().epic,
        summary: "Edited enrollment validation",
      },
    };
    const revised = draftDetail({
      id: 45,
      version: 4,
      draft: editedBundle,
      renderedMarkdown: "# Epic: Edited enrollment validation",
    });
    deps.repository.getSourceById.mockResolvedValueOnce(sourceSummary());
    deps.repository.getLatestDraft
      .mockResolvedValueOnce(latest)
      .mockResolvedValueOnce(revised);
    deps.repository.reviseDraft.mockResolvedValueOnce(45);

    await expect(
      deps.service.updateDraft({
        sourceId: 12,
        draftId: 44,
        draft: editedBundle,
        actor: "kkompalli",
      }),
    ).resolves.toBe(revised);

    expect(deps.repository.reviseDraft).toHaveBeenCalledWith({
      sourceId: 12,
      previousDraftId: 44,
      version: 4,
      evidenceSnapshotId: null,
      bundle: expect.objectContaining({
        epic: expect.objectContaining({
          summary: "Edited enrollment validation",
          acceptanceCriteria: [expect.stringContaining("Scenario:")],
        }),
        childTickets: [
          expect.objectContaining({
            acceptanceCriteria: expect.arrayContaining([
              expect.stringContaining("Given "),
              expect.stringContaining("When "),
              expect.stringContaining("Then "),
            ]),
          }),
        ],
      }),
      renderedMarkdown: expect.stringContaining(
        "# Epic: Edited enrollment validation",
      ),
      evidenceManifest: latest.evidenceManifest,
      modelMetadata: {
        source: "operator_edit",
        actor: "kkompalli",
        previousDraftId: 44,
        validationWarnings: [],
      },
    });
    expect(deps.repository.recordEvent).toHaveBeenCalledWith(
      12,
      "draft_edited",
      "kkompalli",
      {
        previousDraftId: 44,
        draftId: 45,
        version: 4,
        warnings: [],
      },
    );
  });

  it("updateDraft rejects stale or non-ready drafts", async () => {
    const deps = makeDeps();
    deps.repository.getSourceById.mockResolvedValue(sourceSummary());
    deps.repository.getLatestDraft.mockResolvedValueOnce(
      draftDetail({ id: 45 }),
    );

    await expect(
      deps.service.updateDraft({
        sourceId: 12,
        draftId: 44,
        draft: validBundle(),
        actor: "kkompalli",
      }),
    ).rejects.toThrow("is not the latest draft");

    deps.repository.getLatestDraft.mockResolvedValueOnce(
      draftDetail({ id: 44, status: "approved" }),
    );
    await expect(
      deps.service.updateDraft({
        sourceId: 12,
        draftId: 44,
        draft: validBundle(),
        actor: "kkompalli",
      }),
    ).rejects.toThrow("must be ready");
    expect(deps.repository.reviseDraft).not.toHaveBeenCalled();
  });

  it("updateDraft rejects invalid edited draft bundles", async () => {
    const deps = makeDeps();
    const invalid = {
      ...validBundle(),
      childTickets: [
        {
          ...validBundle().childTickets[0],
          acceptanceCriteria: ["Too thin"],
        },
      ],
    };
    deps.repository.getSourceById.mockResolvedValueOnce(sourceSummary());
    deps.repository.getLatestDraft.mockResolvedValueOnce(draftDetail());

    await expect(
      deps.service.updateDraft({
        sourceId: 12,
        draftId: 44,
        draft: invalid as SpecFactoryDraftBundle,
        actor: "kkompalli",
      }),
    ).rejects.toThrow(/failed validation/i);
    expect(deps.repository.reviseDraft).not.toHaveBeenCalled();
  });

  it("approveDraft rejects when the requested draft is not latest", async () => {
    const deps = makeDeps();
    deps.repository.getSourceById.mockResolvedValueOnce(sourceSummary());
    deps.repository.getLatestDraft.mockResolvedValueOnce(
      draftDetail({ id: 45 }),
    );

    await expect(
      deps.service.approveDraft({
        sourceId: 12,
        draftId: 44,
        actor: "kkompalli",
      }),
    ).rejects.toThrow("is not the latest draft");
    expect(deps.publisher.approveDraft).not.toHaveBeenCalled();
  });

  it("approveDraft skips an already-complete publish without calling Jira", async () => {
    const deps = makeDeps();
    const latest = draftDetail({
      status: "approved",
      childTickets: [
        {
          ...draftDetail().childTickets[0],
          jiraKey: "CPDEV-22412",
          state: "created",
        },
      ],
    });
    deps.repository.getSourceById.mockResolvedValueOnce(
      sourceSummary({ state: "approved", approvedEpicKey: "CPDEV-22411" }),
    );
    deps.repository.getLatestDraft.mockResolvedValueOnce(latest);

    await expect(
      deps.service.approveDraft({
        sourceId: 12,
        draftId: 44,
        actor: "kkompalli",
      }),
    ).resolves.toBe(latest);

    expect(deps.publisher.approveDraft).not.toHaveBeenCalled();
    expect(deps.repository.markDraftApproved).not.toHaveBeenCalled();
    expect(deps.repository.recordEvent).toHaveBeenCalledWith(
      12,
      "draft_publish_skipped",
      "kkompalli",
      {
        draftId: 44,
        epicKey: "CPDEV-22411",
        reason: "already_complete",
        childCount: 1,
      },
    );
  });

  it("approveDraft reuses an existing Epic and records only newly-created children", async () => {
    const deps = makeDeps();
    const latest = draftDetail({
      status: "approved",
      childTickets: [
        {
          ...draftDetail().childTickets[0],
          jiraKey: "CPDEV-22412",
          state: "created",
        },
        {
          ...draftDetail().childTickets[0],
          id: 100,
          repoName: "service-api",
          summary: "[service-api] Add validation",
          jiraKey: null,
        },
      ],
    });
    deps.repository.getSourceById.mockResolvedValueOnce(
      sourceSummary({ state: "approved", approvedEpicKey: "CPDEV-22411" }),
    );
    deps.repository.getLatestDraft
      .mockResolvedValueOnce(latest)
      .mockResolvedValueOnce(latest);
    deps.publisher.approveDraft.mockImplementationOnce(
      async (_draft, options) => {
        await options.onChildCreated({
          childId: 100,
          jiraKey: "CPDEV-22413",
        });
        return {
          epicKey: "CPDEV-22411",
          children: [{ childId: 100, jiraKey: "CPDEV-22413" }],
        };
      },
    );

    await deps.service.approveDraft({
      sourceId: 12,
      draftId: 44,
      actor: "kkompalli",
    });

    expect(deps.publisher.approveDraft).toHaveBeenCalledWith(
      latest,
      expect.objectContaining({ existingEpicKey: "CPDEV-22411" }),
    );
    expect(deps.repository.updateChildCreated).toHaveBeenCalledWith(
      100,
      "CPDEV-22413",
    );
    expect(deps.repository.updateChildCreated).not.toHaveBeenCalledWith(
      99,
      "CPDEV-22412",
    );
  });

  it("approveDraft persists a created child before a later child create fails", async () => {
    const repository = makeDeps().repository;
    const failingPublisher = {
      approveDraft: vi.fn(async (_draft, options) => {
        await options.onChildCreated({
          childId: 99,
          jiraKey: "CPDEV-22412",
        });
        throw new Error("second child create failed");
      }),
    };
    const service = new SpecFactoryService(
      repository as any,
      { refresh: vi.fn() },
      { collect: vi.fn() },
      { collect: vi.fn() },
      { generate: vi.fn() },
      failingPublisher,
      { submitChildren: vi.fn() },
      { prepare: vi.fn() },
      { repoDeepDiveEnabled: true },
    );
    repository.getSourceById.mockResolvedValueOnce(sourceSummary());
    repository.getLatestDraft.mockResolvedValueOnce(
      draftDetail({
        childTickets: [
          draftDetail().childTickets[0],
          {
            ...draftDetail().childTickets[0],
            id: 100,
            repoName: "service-api",
            summary: "[service-api] Add validation",
          },
        ],
      }),
    );

    await expect(
      service.approveDraft({ sourceId: 12, draftId: 44, actor: "kkompalli" }),
    ).rejects.toThrow("second child create failed");
    expect(repository.updateChildCreated).toHaveBeenCalledWith(
      99,
      "CPDEV-22412",
    );
    expect(repository.markDraftApproved).not.toHaveBeenCalled();
    expect(repository.recordEvent).toHaveBeenCalledWith(
      12,
      "draft_publish_failed",
      "kkompalli",
      {
        draftId: 44,
        epicKey: null,
        failedStep: "child",
        failedChild: {
          childId: 100,
          repoName: "service-api",
          summary: "[service-api] Add validation",
        },
        remainingChildren: [
          {
            childId: 100,
            repoName: "service-api",
            summary: "[service-api] Add validation",
          },
        ],
        createdChildren: [{ childId: 99, jiraKey: "CPDEV-22412" }],
        error: "second child create failed",
      },
    );
  });

  it("approveDraft retries after a partial Jira failure without recreating completed work", async () => {
    const deps = makeDeps();
    const createIssue = vi
      .fn()
      .mockResolvedValueOnce({ key: "CPDEV-22411" })
      .mockResolvedValueOnce({ key: "CPDEV-22412" })
      .mockRejectedValueOnce(new Error("second child create failed"))
      .mockResolvedValueOnce({ key: "CPDEV-22413" });
    const service = new SpecFactoryService(
      deps.repository as any,
      deps.ingestor,
      deps.evidenceCollector,
      deps.repoContextCollector,
      deps.generator,
      new JiraPublisher({ createIssue }),
      deps.submitter,
      deps.evidenceWorkspaceManager,
      { repoDeepDiveEnabled: true, qualifier: deps.qualifier },
    );
    const firstRunDraft = draftDetail({
      childTickets: [
        draftDetail().childTickets[0],
        {
          ...draftDetail().childTickets[0],
          id: 100,
          repoName: "service-api",
          summary: "[service-api] Add validation",
        },
      ],
    });
    const retryDraft = draftDetail({
      childTickets: [
        {
          ...draftDetail().childTickets[0],
          jiraKey: "CPDEV-22412",
          state: "created",
        },
        {
          ...draftDetail().childTickets[0],
          id: 100,
          repoName: "service-api",
          summary: "[service-api] Add validation",
        },
      ],
    });
    deps.repository.getSourceById
      .mockResolvedValueOnce(sourceSummary())
      .mockResolvedValueOnce(
        sourceSummary({ state: "approved", approvedEpicKey: "CPDEV-22411" }),
      );
    deps.repository.getLatestDraft
      .mockResolvedValueOnce(firstRunDraft)
      .mockResolvedValueOnce(retryDraft)
      .mockResolvedValueOnce(draftDetail({ status: "approved" }));

    await expect(
      service.approveDraft({ sourceId: 12, draftId: 44, actor: "kkompalli" }),
    ).rejects.toThrow("second child create failed");
    expect(deps.repository.updateSourceApproved).toHaveBeenCalledWith(
      12,
      "CPDEV-22411",
    );
    expect(deps.repository.updateChildCreated).toHaveBeenCalledWith(
      99,
      "CPDEV-22412",
    );
    expect(deps.repository.markDraftApproved).not.toHaveBeenCalled();

    deps.repository.markDraftApproved.mockClear();
    deps.repository.updateChildCreated.mockClear();

    await expect(
      service.approveDraft({ sourceId: 12, draftId: 44, actor: "kkompalli" }),
    ).resolves.toEqual(draftDetail({ status: "approved" }));

    expect(createIssue).toHaveBeenCalledTimes(4);
    expect(createIssue).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        issueType: "Story",
        parentKey: "CPDEV-22411",
        summary: "[service-api] Add validation",
      }),
    );
    expect(deps.repository.updateChildCreated).toHaveBeenCalledTimes(1);
    expect(deps.repository.updateChildCreated).toHaveBeenCalledWith(
      100,
      "CPDEV-22413",
    );
    expect(deps.repository.markDraftApproved).toHaveBeenCalledWith(
      44,
      "kkompalli",
    );
  });

  it("oneShotNow submits approved children and marks results", async () => {
    const deps = makeDeps();
    const children = [
      {
        ...draftDetail().childTickets[0],
        jiraKey: "CPDEV-22412",
        state: "created" as const,
      },
    ];
    const results = [{ childId: 99, requestId: 701 }];
    deps.repository.listApprovedChildren.mockResolvedValueOnce(children);
    deps.submitter.submitChildren.mockResolvedValueOnce(results);

    await expect(
      deps.service.oneShotNow({
        sourceId: 12,
        actor: { id: "kkompalli", display: "K Kompalli" },
      }),
    ).resolves.toEqual({ submittedCount: 1, results });

    expect(deps.submitter.submitChildren).toHaveBeenCalledWith(
      expect.objectContaining({
        children,
        actor: { id: "kkompalli", display: "K Kompalli" },
      }),
    );
    expect(deps.repository.updateChildSubmitted).toHaveBeenCalledWith(99, 701);
    expect(deps.repository.markSourceOneShotSubmitted).toHaveBeenCalledWith(12);
    expect(deps.repository.recordEvent).toHaveBeenCalledWith(
      12,
      "oneshot_submitted",
      "kkompalli",
      { results },
    );
  });

  it("oneShotNow rejects when there are no approved children to submit", async () => {
    const deps = makeDeps();
    deps.repository.listApprovedChildren.mockResolvedValueOnce([]);

    await expect(
      deps.service.oneShotNow({
        sourceId: 12,
        actor: { id: "kkompalli", display: "K Kompalli" },
      }),
    ).rejects.toThrow(
      "Spec Factory source 12 has no approved child tickets ready for OneShot",
    );

    expect(deps.submitter.submitChildren).not.toHaveBeenCalled();
    expect(deps.repository.markSourceOneShotSubmitted).not.toHaveBeenCalled();
    expect(deps.repository.recordEvent).not.toHaveBeenCalledWith(
      12,
      "oneshot_submitted",
      expect.any(String),
      expect.anything(),
    );
  });

  it("oneShotNow rejects while the latest draft has unpublished children", async () => {
    const deps = makeDeps();
    deps.repository.getLatestDraft.mockResolvedValueOnce(
      draftDetail({
        status: "approved",
        childTickets: [
          {
            ...draftDetail().childTickets[0],
            jiraKey: "CPDEV-22412",
            state: "created",
          },
          {
            ...draftDetail().childTickets[0],
            id: 100,
            repoName: "service-api",
            summary: "[service-api] Add validation",
            jiraKey: null,
          },
        ],
      }),
    );

    await expect(
      deps.service.oneShotNow({
        sourceId: 12,
        actor: { id: "kkompalli", display: "K Kompalli" },
      }),
    ).rejects.toThrow(
      "Spec Factory source 12 still has 1 unpublished child ticket; retry Jira publish before OneShot submission",
    );

    expect(deps.repository.listApprovedChildren).not.toHaveBeenCalled();
    expect(deps.submitter.submitChildren).not.toHaveBeenCalled();
    expect(deps.repository.markSourceOneShotSubmitted).not.toHaveBeenCalled();
  });

  it("oneShotNow persists submitted children before a later submission fails", async () => {
    const deps = makeDeps();
    const children = [
      {
        ...draftDetail().childTickets[0],
        jiraKey: "CPDEV-22412",
        state: "created" as const,
      },
      {
        ...draftDetail().childTickets[0],
        id: 100,
        repoName: "service-api",
        summary: "[service-api] Add validation",
        jiraKey: "CPDEV-22413",
        state: "created" as const,
      },
    ];
    deps.repository.listApprovedChildren.mockResolvedValueOnce(children);
    deps.submitter.submitChildren.mockImplementationOnce(async (input) => {
      await input.onChildSubmitted?.({ childId: 99, requestId: 701 });
      throw new Error("second child submit failed");
    });

    await expect(
      deps.service.oneShotNow({
        sourceId: 12,
        actor: { id: "kkompalli", display: "K Kompalli" },
      }),
    ).rejects.toThrow("second child submit failed");

    expect(deps.repository.updateChildSubmitted).toHaveBeenCalledWith(99, 701);
    expect(deps.repository.updateChildSubmitted).toHaveBeenCalledTimes(1);
    expect(deps.repository.markSourceOneShotSubmitted).not.toHaveBeenCalled();
    expect(deps.repository.recordEvent).toHaveBeenCalledWith(
      12,
      "oneshot_submission_failed",
      "kkompalli",
      {
        submittedResults: [{ childId: 99, requestId: 701 }],
        failedChild: {
          childId: 100,
          repoName: "service-api",
          summary: "[service-api] Add validation",
          jiraKey: "CPDEV-22413",
        },
        remainingChildren: [
          {
            childId: 100,
            repoName: "service-api",
            summary: "[service-api] Add validation",
            jiraKey: "CPDEV-22413",
          },
        ],
        error: "second child submit failed",
      },
    );
  });

  it("oneShotNow skips children that already have a OneShot request", async () => {
    const deps = makeDeps();
    const submittedChild = {
      ...draftDetail().childTickets[0],
      jiraKey: "CPDEV-22412",
      state: "oneshot_requested" as const,
      oneshotRequestId: 701,
    };
    const readyChild = {
      ...draftDetail().childTickets[0],
      id: 100,
      jiraKey: "CPDEV-22413",
      state: "created" as const,
    };
    const results = [{ childId: 100, requestId: 702 }];
    deps.repository.listApprovedChildren.mockResolvedValueOnce([
      submittedChild,
      readyChild,
    ]);
    deps.submitter.submitChildren.mockResolvedValueOnce(results);

    await expect(
      deps.service.oneShotNow({
        sourceId: 12,
        actor: { id: "kkompalli", display: "K Kompalli" },
      }),
    ).resolves.toEqual({ submittedCount: 1, results });

    expect(deps.submitter.submitChildren).toHaveBeenCalledWith(
      expect.objectContaining({
        children: [readyChild],
        actor: { id: "kkompalli", display: "K Kompalli" },
      }),
    );
    expect(deps.repository.updateChildSubmitted).toHaveBeenCalledTimes(1);
    expect(deps.repository.updateChildSubmitted).toHaveBeenCalledWith(100, 702);
    expect(deps.repository.updateChildSubmitted).not.toHaveBeenCalledWith(
      99,
      701,
    );
  });

  it("oneShotNow rejects when all approved children were already submitted", async () => {
    const deps = makeDeps();
    deps.repository.listApprovedChildren.mockResolvedValueOnce([
      {
        ...draftDetail().childTickets[0],
        jiraKey: "CPDEV-22412",
        state: "oneshot_requested" as const,
        oneshotRequestId: 701,
      },
    ]);

    await expect(
      deps.service.oneShotNow({
        sourceId: 12,
        actor: { id: "kkompalli", display: "K Kompalli" },
      }),
    ).rejects.toThrow(
      "Spec Factory source 12 has no approved child tickets ready for OneShot",
    );

    expect(deps.submitter.submitChildren).not.toHaveBeenCalled();
    expect(deps.repository.markSourceOneShotSubmitted).not.toHaveBeenCalled();
  });
});

describe("JiraPublisher", () => {
  it("does not call Jira when an existing Epic and all children already exist", async () => {
    const createIssue = vi.fn();
    const publisher = new JiraPublisher({ createIssue });
    const onEpicCreated = vi.fn();
    const onChildCreated = vi.fn();

    await expect(
      publisher.approveDraft(
        draftDetail({
          childTickets: [
            {
              ...draftDetail().childTickets[0],
              jiraKey: "CPDEV-22412",
              state: "created",
            },
            {
              ...draftDetail().childTickets[0],
              id: 100,
              repoName: "service-api",
              summary: "[service-api] Add validation",
              jiraKey: "CPDEV-22413",
              state: "created",
            },
          ],
        }),
        { existingEpicKey: "CPDEV-22411", onEpicCreated, onChildCreated },
      ),
    ).resolves.toEqual({
      epicKey: "CPDEV-22411",
      children: [],
    });

    expect(createIssue).not.toHaveBeenCalled();
    expect(onEpicCreated).not.toHaveBeenCalled();
    expect(onChildCreated).not.toHaveBeenCalled();
  });

  it("reuses an existing Epic and creates only missing child stories", async () => {
    const createIssue = vi.fn().mockResolvedValueOnce({
      key: "CPDEV-22413",
      summary: "[service-api] Add validation",
    });
    const publisher = new JiraPublisher({ createIssue });
    const onEpicCreated = vi.fn();
    const onChildCreated = vi.fn();

    await expect(
      publisher.approveDraft(
        draftDetail({
          childTickets: [
            {
              ...draftDetail().childTickets[0],
              jiraKey: "CPDEV-22412",
              state: "created",
            },
            {
              ...draftDetail().childTickets[0],
              id: 100,
              repoName: "service-api",
              summary: "[service-api] Add validation",
            },
          ],
        }),
        { existingEpicKey: "CPDEV-22411", onEpicCreated, onChildCreated },
      ),
    ).resolves.toEqual({
      epicKey: "CPDEV-22411",
      children: [{ childId: 100, jiraKey: "CPDEV-22413" }],
    });

    expect(createIssue).toHaveBeenCalledTimes(1);
    expect(onEpicCreated).not.toHaveBeenCalled();
    expect(createIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        issueType: "Story",
        parentKey: "CPDEV-22411",
        summary: "[service-api] Add validation",
      }),
    );
    expect(onChildCreated).toHaveBeenCalledWith({
      childId: 100,
      jiraKey: "CPDEV-22413",
    });
  });

  it("uses configured Jira project and issue types", async () => {
    const createIssue = vi
      .fn()
      .mockResolvedValueOnce({
        key: "OPS-1",
        summary: "Deliver enrollment sync rules",
      })
      .mockResolvedValueOnce({
        key: "OPS-2",
        summary: "Implement sync rule service changes",
      });
    const publisher = new JiraPublisher(
      { createIssue },
      {
        projectKey: "OPS",
        epicIssueType: "Initiative",
        childIssueType: "Task",
      },
    );

    await expect(publisher.approveDraft(draftDetail())).resolves.toEqual({
      epicKey: "OPS-1",
      children: [{ childId: 99, jiraKey: "OPS-2" }],
    });

    expect(createIssue).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        projectKey: "OPS",
        issueType: "Initiative",
      }),
    );
    expect(createIssue).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        projectKey: "OPS",
        issueType: "Task",
        parentKey: "OPS-1",
      }),
    );
  });
});
