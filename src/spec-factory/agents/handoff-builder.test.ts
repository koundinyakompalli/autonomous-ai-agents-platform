import { describe, expect, it, vi } from "vitest";
import type {
  ComposeContextProjection,
  ComposeSessionSourceSummary,
  ComposeSessionSummary,
} from "../compose-types.js";
import type { ClaimedAgentTask } from "../compose-database.js";
import {
  HandoffBuildExecutor,
  HANDOFF_SOURCE_SUMMARY_MAX_CHARS,
  buildHandoffBundle,
  createHandoffExecutorRegistry,
} from "./handoff-builder.js";

function session(
  overrides: Partial<ComposeSessionSummary> = {},
): ComposeSessionSummary {
  return {
    id: 7,
    name: "Billing export",
    createdBy: null,
    createdByDisplay: null,
    status: "ready",
    claudeSessionId: null,
    sourceId: null,
    readiness: {
      ready: true,
      summary: "The export workflow is understood.",
      openQuestions: ["Which export format is required?"],
      risks: ["Large reports may time out."],
      assumptions: ["Billing users can access the export page."],
    },
    s3Prefix: "compose/7/",
    workspacePath: "/mnt/efs/spec-factory/compose/7",
    sourceCount: 2,
    passwordProtected: false,
    latestContextVersion: 4,
    createdAt: "2026-06-02T00:00:00.000Z",
    updatedAt: "2026-06-02T00:00:00.000Z",
    ...overrides,
  };
}

function source(
  overrides: Partial<ComposeSessionSourceSummary> = {},
): ComposeSessionSourceSummary {
  return {
    id: 21,
    sessionId: 7,
    requestId: null,
    kind: "file",
    originalFilename: "requirements.docx",
    mimeType: null,
    sizeBytes: null,
    sourceUrl: null,
    s3KeyRaw: null,
    converter: "markitdown",
    markdownPath: null,
    markdownContent: null,
    sourceSummary: "Export requirements.",
    conversionStatus: "converted",
    conversionStartedAt: null,
    conversionAttempts: 1,
    conversionLeaseExpiresAt: null,
    errorMessage: null,
    createdAt: "2026-06-02T00:00:00.000Z",
    updatedAt: "2026-06-02T00:00:00.000Z",
    ...overrides,
  };
}

function contextProjection(
  overrides: Partial<ComposeContextProjection> = {},
): ComposeContextProjection {
  return {
    sessionId: 7,
    version: 4,
    artifactUri: "file:///workspaces/compose/7/context/working-context-v4.md",
    structuredArtifactUri:
      "file:///workspaces/compose/7/context/working-context-v4.json",
    summary: {
      objective: "Deliver billing exports.",
      problemStatement: "Operators need an auditable export flow.",
      recommendedNextActions: ["Draft the API contract."],
    },
    facts: ["Billing service owns export generation."],
    implementationFindings: [],
    requirements: [],
    constraints: [],
    openQuestions: ["Confirm CSV vs XLSX."],
    conflicts: [],
    decisions: ["Use the existing export controller."],
    risks: [],
    sourceIds: [21, 22],
    patchIds: [501],
    committedAt: "2026-06-02T00:05:00.000Z",
    ...overrides,
  };
}

function handoffTask(
  overrides: Partial<ClaimedAgentTask> = {},
): ClaimedAgentTask {
  return {
    id: 501,
    sessionId: 7,
    turnJobId: null,
    capability: "handoff_build",
    executorType: "handoff_build",
    status: "running",
    input: {
      handoffId: 701,
      sourceId: 88,
      actor: "kompallik",
      contextVersionUsed: 4,
      messageHighWatermarkId: 900,
    },
    leaseGeneration: 2,
    activeWorkerId: "agent-worker-a",
    ...overrides,
  };
}

describe("buildHandoffBundle", () => {
  it("builds a bounded source summary from readiness and source metadata", () => {
    const bundle = buildHandoffBundle({
      session: session(),
      sources: [
        source(),
        source({
          id: 22,
          kind: "generated_research",
          originalFilename: "research.md",
          sourceSummary: "Code research found the billing export endpoint.",
        }),
      ],
    });

    expect(bundle.sourceSummary).toContain("Billing export");
    expect(bundle.sourceSummary).toContain("ready");
    expect(bundle.sourceSummary).toContain("2 sources");
    expect(bundle.sourceSummary).toContain("1 research artifact");
    expect(bundle.sourceSummary).toContain("context v4");
    expect(bundle.sourceSummary).toContain(
      "open: Which export format is required?",
    );
    expect(bundle.sourceSummary.length).toBeLessThanOrEqual(
      HANDOFF_SOURCE_SUMMARY_MAX_CHARS,
    );
    expect(bundle.markdown).toContain("# Handoff: Billing export");
    expect(bundle.markdown).toContain("## Generated research");
    expect(bundle.json).toMatchObject({
      schemaVersion: 2,
      sessionId: 7,
      sessionName: "Billing export",
      status: "ready",
      latestContextVersion: 4,
      generatedResearch: [
        expect.objectContaining({
          id: 22,
          filename: "research.md",
          summary: "Code research found the billing export endpoint.",
        }),
      ],
    });
    expect(bundle.jsonText).toContain('"schemaVersion": 2');
  });

  it("includes the latest Working Context projection when provided", () => {
    const bundle = buildHandoffBundle({
      session: session(),
      sources: [source()],
      contextProjection: contextProjection(),
    });

    expect(bundle.markdown).toContain("## Working Context");
    expect(bundle.markdown).toContain("Version: 4");
    expect(bundle.markdown).toContain("Deliver billing exports.");
    expect(bundle.markdown).toContain(
      "Billing service owns export generation.",
    );
    expect(bundle.markdown).toContain("Confirm CSV vs XLSX.");
    expect(bundle.markdown).toContain("Use the existing export controller.");
    expect(bundle.json.workingContext).toMatchObject({
      version: 4,
      summary: {
        objective: "Deliver billing exports.",
        problemStatement: "Operators need an auditable export flow.",
      },
      sourceIds: [21, 22],
      patchIds: [501],
    });
  });

  it("truncates long source summaries to the legacy column limit", () => {
    const bundle = buildHandoffBundle({
      session: session({
        name: "Billing export ".repeat(40),
        readiness: {
          ready: true,
          summary: "Ready",
          openQuestions: ["Which downstream integration owns this export?"],
        },
      }),
      sources: [source()],
    });

    expect(bundle.truncated).toBe(true);
    expect(bundle.sourceSummary.length).toBe(HANDOFF_SOURCE_SUMMARY_MAX_CHARS);
    expect(bundle.sourceSummary.endsWith("...")).toBe(true);
  });
});

describe("HandoffBuildExecutor", () => {
  it("persists handoff artifacts, records evidence, and requests draft generation", async () => {
    const repository = {
      getSession: vi.fn().mockResolvedValue(session({ sourceId: 88 })),
      listSessionSources: vi.fn().mockResolvedValue([
        source(),
        source({
          id: 22,
          kind: "generated_research",
          originalFilename: "research.md",
          sourceSummary: "Code research found the export endpoint.",
        }),
      ]),
      getContextProjection: vi.fn().mockResolvedValue(contextProjection()),
      listMessages: vi.fn().mockResolvedValue([]),
      confirmAgentTaskLease: vi.fn().mockResolvedValue(true),
      commitHandoffSnapshot: vi.fn().mockResolvedValue(901),
      markHandoffDraftQueued: vi.fn().mockResolvedValue(undefined),
    };
    const specRepository = {
      createEvidenceSnapshot: vi.fn().mockResolvedValue(777),
    };
    const workspace = {
      writeArtifact: vi.fn(async ({ relativePath, content }) => ({
        artifactUri: `file:///workspaces/compose/7/${relativePath}`,
        relativePath,
        bytes: Buffer.byteLength(String(content)),
        sha256: `sha-${relativePath}`,
      })),
    };
    const draftRequester = {
      requestDraftGeneration: vi
        .fn()
        .mockResolvedValue({ queued: true, workflowId: 1001 }),
    };

    const output = await new HandoffBuildExecutor(
      repository,
      specRepository,
      workspace,
      draftRequester,
    ).execute(handoffTask());

    expect(repository.getSession).toHaveBeenCalledWith(7);
    expect(repository.listSessionSources).toHaveBeenCalledWith(7);
    expect(repository.getContextProjection).toHaveBeenCalledWith(7, 4);
    expect(repository.listMessages).toHaveBeenCalledWith(7);
    expect(repository.confirmAgentTaskLease).toHaveBeenCalledWith({
      agentTaskId: 501,
      workerId: "agent-worker-a",
      leaseGeneration: 2,
    });
    expect(workspace.writeArtifact).toHaveBeenNthCalledWith(1, {
      workspacePath: "/mnt/efs/spec-factory/compose/7",
      relativePath: "handoff/701/handoff-v2.md",
      content: expect.stringContaining("# Handoff: Billing export"),
    });
    expect(workspace.writeArtifact).toHaveBeenNthCalledWith(2, {
      workspacePath: "/mnt/efs/spec-factory/compose/7",
      relativePath: "handoff/701/handoff-v2.json",
      content: expect.stringContaining('"schemaVersion": 2'),
    });
    expect(specRepository.createEvidenceSnapshot).toHaveBeenCalledWith({
      sourceId: 88,
      manifest: expect.objectContaining({
        sourceJiraKey: "COMPOSE-7",
        sourceSummary: expect.stringContaining("Billing export"),
        descriptionMarkdown: expect.stringContaining("## Working Context"),
        artifacts: [
          expect.objectContaining({
            filename: "handoff-v2.md",
            artifactUri:
              "file:///workspaces/compose/7/handoff/701/handoff-v2.md",
          }),
          expect.objectContaining({
            filename: "handoff-v2.json",
            artifactUri:
              "file:///workspaces/compose/7/handoff/701/handoff-v2.json",
          }),
        ],
      }),
    });
    expect(
      specRepository.createEvidenceSnapshot.mock.invocationCallOrder[0],
    ).toBeLessThan(
      draftRequester.requestDraftGeneration.mock.invocationCallOrder[0],
    );
    expect(draftRequester.requestDraftGeneration).toHaveBeenCalledWith({
      sourceId: 88,
      actor: "kompallik",
      idempotencyKey: "handoff-701",
      handoffSnapshotId: 901,
    });
    expect(repository.commitHandoffSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        handoffId: 701,
        sourceId: 88,
        contextVersionUsed: 4,
        messageHighWatermarkId: 900,
        artifactUri: "file:///workspaces/compose/7/handoff/701/handoff-v2.json",
      }),
    );
    expect(repository.markHandoffDraftQueued).toHaveBeenCalledWith({
      handoffId: 701,
      draftWorkflowId: 1001,
    });
    expect(output).toMatchObject({
      outputSourceId: null,
      contextVersionUsed: 4,
      output: {
        sourceId: 88,
        handoffId: 701,
        snapshotId: 901,
        draftWorkflowId: 1001,
        evidenceSnapshotId: 777,
        artifactBytes: expect.objectContaining({
          markdown: expect.any(Number),
          json: expect.any(Number),
          total: expect.any(Number),
        }),
      },
    });
  });

  it("adds LLM-authored narrative fields to queued handoff artifacts when enabled", async () => {
    const repository = {
      getSession: vi.fn().mockResolvedValue(session({ sourceId: 88 })),
      listSessionSources: vi.fn().mockResolvedValue([
        source(),
        source({
          id: 22,
          kind: "generated_research",
          originalFilename: "research.md",
          sourceSummary: "Code research found the export endpoint.",
        }),
      ]),
      getContextProjection: vi.fn().mockResolvedValue(contextProjection()),
      listMessages: vi.fn().mockResolvedValue([]),
      confirmAgentTaskLease: vi.fn().mockResolvedValue(true),
      commitHandoffSnapshot: vi.fn().mockResolvedValue(901),
      markHandoffDraftQueued: vi.fn().mockResolvedValue(undefined),
    };
    const specRepository = {
      createEvidenceSnapshot: vi.fn().mockResolvedValue(777),
    };
    const workspace = {
      writeArtifact: vi.fn(async ({ relativePath, content }) => ({
        artifactUri: `file:///workspaces/compose/7/${relativePath}`,
        relativePath,
        bytes: Buffer.byteLength(String(content)),
        sha256: `sha-${relativePath}`,
      })),
    };
    const draftRequester = {
      requestDraftGeneration: vi.fn().mockResolvedValue({ queued: true }),
    };
    const llmGateway = {
      generateObject: vi.fn().mockResolvedValue({
        executiveSummary:
          "Use the existing billing export endpoint and keep audit logging.",
        implementationBrief:
          "Draft the Louise story around the current export controller, adding timeout handling for large reports.",
        evidenceMap: [
          {
            claim: "The billing service owns export generation.",
            sourceIds: [22],
            notes: "Generated code research traced the endpoint.",
          },
        ],
        openQuestions: ["Confirm CSV or XLSX as the required output format."],
      }),
    };

    await new (HandoffBuildExecutor as any)(
      repository,
      specRepository,
      workspace,
      draftRequester,
      { llmGateway, enableLlmNarrative: true },
    ).execute(handoffTask());

    expect(llmGateway.generateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 7,
        agentTaskId: 501,
        purpose: "handoff_synthesis",
        promptVersion: "handoff_synthesis@v1",
        contextVersionUsed: 4,
      }),
    );
    expect(llmGateway.generateObject.mock.calls[0]?.[0].prompt).toContain(
      "Billing export",
    );
    expect(workspace.writeArtifact).toHaveBeenNthCalledWith(1, {
      workspacePath: "/mnt/efs/spec-factory/compose/7",
      relativePath: "handoff/701/handoff-v2.md",
      content: expect.stringContaining("## LLM Handoff Narrative"),
    });
    expect(workspace.writeArtifact).toHaveBeenNthCalledWith(2, {
      workspacePath: "/mnt/efs/spec-factory/compose/7",
      relativePath: "handoff/701/handoff-v2.json",
      content: expect.stringContaining('"executiveSummary"'),
    });
    expect(specRepository.createEvidenceSnapshot).toHaveBeenCalledWith({
      sourceId: 88,
      manifest: expect.objectContaining({
        descriptionMarkdown: expect.stringContaining(
          "Use the existing billing export endpoint",
        ),
      }),
    });
  });

  it("rejects lost leases before writing artifacts or requesting draft generation", async () => {
    const repository = {
      getSession: vi.fn().mockResolvedValue(session({ sourceId: 88 })),
      listSessionSources: vi.fn().mockResolvedValue([source()]),
      getContextProjection: vi.fn().mockResolvedValue(contextProjection()),
      listMessages: vi.fn().mockResolvedValue([]),
      confirmAgentTaskLease: vi.fn().mockResolvedValue(false),
      commitHandoffSnapshot: vi.fn(),
      markHandoffDraftQueued: vi.fn(),
    };
    const specRepository = {
      createEvidenceSnapshot: vi.fn(),
    };
    const workspace = {
      writeArtifact: vi.fn(),
    };
    const draftRequester = {
      requestDraftGeneration: vi.fn(),
    };

    await expect(
      new HandoffBuildExecutor(
        repository,
        specRepository,
        workspace,
        draftRequester,
      ).execute(handoffTask()),
    ).rejects.toThrow("agent_task_lease_lost");

    expect(repository.confirmAgentTaskLease).toHaveBeenCalledWith({
      agentTaskId: 501,
      workerId: "agent-worker-a",
      leaseGeneration: 2,
    });
    expect(workspace.writeArtifact).not.toHaveBeenCalled();
    expect(specRepository.createEvidenceSnapshot).not.toHaveBeenCalled();
    expect(draftRequester.requestDraftGeneration).not.toHaveBeenCalled();
  });

  it("stops handoff build when the lease is lost between artifact writes", async () => {
    const repository = {
      getSession: vi.fn().mockResolvedValue(session({ sourceId: 88 })),
      listSessionSources: vi.fn().mockResolvedValue([source()]),
      getContextProjection: vi.fn().mockResolvedValue(contextProjection()),
      listMessages: vi.fn().mockResolvedValue([]),
      confirmAgentTaskLease: vi
        .fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false),
      commitHandoffSnapshot: vi.fn(),
      markHandoffDraftQueued: vi.fn(),
    };
    const specRepository = {
      createEvidenceSnapshot: vi.fn(),
    };
    const workspace = {
      writeArtifact: vi.fn(async ({ relativePath, content }) => ({
        artifactUri: `file:///workspaces/compose/7/${relativePath}`,
        relativePath,
        bytes: Buffer.byteLength(String(content)),
        sha256: `sha-${relativePath}`,
      })),
    };
    const draftRequester = {
      requestDraftGeneration: vi.fn(),
    };

    await expect(
      new HandoffBuildExecutor(
        repository,
        specRepository,
        workspace,
        draftRequester,
      ).execute(handoffTask()),
    ).rejects.toThrow("agent_task_lease_lost");

    expect(workspace.writeArtifact).toHaveBeenCalledTimes(1);
    expect(specRepository.createEvidenceSnapshot).not.toHaveBeenCalled();
    expect(draftRequester.requestDraftGeneration).not.toHaveBeenCalled();
  });

  it("exposes the handoff_build executor through its registry", () => {
    const registry = createHandoffExecutorRegistry(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    expect(registry.listExecutorTypes()).toEqual(["handoff_build"]);
  });
});
