import { describe, expect, it, vi } from "vitest";
import {
  ContextMergeExecutor,
  SOURCE_DISTILLATION_JSON_SCHEMA,
  SourceDistillationPatchSchema,
  SourceDistillationExecutor,
  createContextExecutorRegistry,
} from "./context-executors.js";

function claimedTask(overrides = {}) {
  return {
    id: 501,
    sessionId: 7,
    turnJobId: null,
    capability: "source_distillation",
    executorType: "source_distillation",
    status: "running",
    input: { sourceId: 61, baseContextVersion: 4 },
    leaseGeneration: 1,
    activeWorkerId: "agent-worker-a",
    ...overrides,
  };
}

function sourceSummary(overrides = {}) {
  return {
    id: 61,
    sessionId: 7,
    kind: "generated_research",
    originalFilename: "code-research.md",
    mimeType: "text/markdown",
    sizeBytes: 2048,
    sourceUrl: null,
    s3KeyRaw: null,
    converter: "none",
    markdownPath: null,
    markdownContent:
      "# Research\n\nBilling service owns invoice exports.\n\nOpen question: Which queue processes invoices?",
    sourceSummary: "Billing export research",
    sourceEntities: {
      jiraKeys: [],
      repositories: ["billing-service"],
      files: ["src/billing/export.ts"],
      clients: [],
      loeHours: [],
      dates: [],
      assumptions: [],
    },
    sourceUsefulness: "high_signal",
    sourceContribution: "Identifies invoice export owner.",
    sourceOrigin: "agent",
    generatedByTaskId: 401,
    parentSourceIds: [12],
    contextVersionUsed: 4,
    evidence: { repositories: ["billing-service"] },
    confidence: "high",
    artifactUri: "file:///workspace/generated/code-research.md",
    artifactSha256: "a".repeat(64),
    artifactBytes: 2048,
    conversionStatus: "converted",
    conversionStartedAt: null,
    conversionAttempts: 1,
    conversionLeaseExpiresAt: null,
    errorMessage: null,
    createdAt: "2026-07-05T10:00:00.000Z",
    updatedAt: "2026-07-05T10:00:00.000Z",
    ...overrides,
  };
}

function contextProjection(overrides = {}) {
  return {
    sessionId: 7,
    version: 4,
    artifactUri: "file:///workspace/context-v4.md",
    structuredArtifactUri: "file:///workspace/context-v4.json",
    summary: {
      objective: "Preserve invoice ordering",
      problemStatement: "Retries must not reorder invoices",
      recommendedNextActions: [],
    },
    facts: [{ id: "parent-fact", text: "Finance owns reconciliation" }],
    implementationFindings: [],
    requirements: [],
    constraints: [],
    openQuestions: [],
    conflicts: [],
    decisions: [],
    risks: [],
    sourceIds: [12],
    patchIds: [700],
    committedAt: "2026-07-05T10:00:00.000Z",
    ...overrides,
  };
}

describe("Phase 7 context executors", () => {
  it("requires canonical text in every LLM distillation item", () => {
    const result = SourceDistillationPatchSchema.safeParse({
      problemStatementAdditions: [],
      facts: [{ fact: "Billing owns invoice exports" }],
      implementationFindings: [],
      requirements: [],
      constraints: [],
      decisions: [],
      openQuestions: [],
      risks: [],
      conflicts: [],
    });
    expect(result.success).toBe(false);

    const properties = SOURCE_DISTILLATION_JSON_SCHEMA.properties as Record<
      string,
      { items?: { required?: string[] } }
    >;
    expect(properties.facts?.items?.required).toEqual(["text"]);
    expect(properties.openQuestions?.items?.required).toEqual(["text"]);
  });

  it("source distillation writes a patch artifact and enqueues one merge task", async () => {
    const repository = {
      getSession: vi.fn().mockResolvedValue({
        id: 7,
        workspacePath: "/workspace/compose/7",
      }),
      getSessionSource: vi.fn().mockResolvedValue(sourceSummary()),
      createReadyContextPatch: vi.fn().mockResolvedValue(701),
      enqueueContextMergeTaskIfNeeded: vi.fn().mockResolvedValue(801),
      appendSessionEvent: vi.fn().mockResolvedValue({ id: 950 }),
    };
    const workspace = {
      writeArtifact: vi.fn().mockResolvedValue({
        artifactUri:
          "file:///workspace/compose/7/context/patches/source-61-task-501.json",
        relativePath: "context/patches/source-61-task-501.json",
        bytes: 512,
        sha256: "b".repeat(64),
      }),
    };
    const executor = new SourceDistillationExecutor(
      repository as never,
      workspace,
    );

    await expect(executor.execute(claimedTask())).resolves.toEqual({
      output: {
        patchId: 701,
        mergeTaskId: 801,
        sourceId: 61,
        artifactUri:
          "file:///workspace/compose/7/context/patches/source-61-task-501.json",
      },
      contextVersionUsed: 4,
    });

    expect(workspace.writeArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath: "/workspace/compose/7",
        relativePath: "context/patches/source-61-task-501.json",
      }),
    );
    const artifactBody = JSON.parse(
      String(workspace.writeArtifact.mock.calls[0][0].content),
    );
    expect(artifactBody).toMatchObject({
      schemaVersion: 4,
      kind: "source_distillation",
      provenance: { sourceId: 61 },
    });
    expect(artifactBody.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          op: "upsert",
          section: "facts",
          item: expect.objectContaining({
            text: "Billing export research",
            confidence: "high",
          }),
        }),
        expect.objectContaining({
          op: "upsert",
          section: "implementationFindings",
          item: expect.objectContaining({
            text: "Which queue processes invoices?",
            questionType: "implementation",
          }),
        }),
      ]),
    );
    expect(
      artifactBody.operations.some(
        (operation: { section?: string }) =>
          operation.section === "openQuestions",
      ),
    ).toBe(false);
    expect(repository.createReadyContextPatch).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 7,
        sourceId: 61,
        agentTaskId: 501,
        turnJobId: null,
        baseContextVersion: 4,
        schemaVersion: 4,
        patchKind: "source_distillation",
        idempotencyKey: "agent-task:501:source-distillation:v4",
        patch: artifactBody,
        patchUri:
          "file:///workspace/compose/7/context/patches/source-61-task-501.json",
        artifactSha256: "b".repeat(64),
        artifactBytes: 512,
      }),
    );
    expect(repository.enqueueContextMergeTaskIfNeeded).toHaveBeenCalledWith({
      sessionId: 7,
      triggerPatchId: 701,
    });
    expect(repository.appendSessionEvent).toHaveBeenCalledWith({
      sessionId: 7,
      eventType: "source.distillation.started",
      payload: {
        sourceId: 61,
        sourceKind: "generated_research",
        baseContextVersion: 4,
      },
      actorType: "system",
      actorId: "source_distillation",
      agentTaskId: 501,
      contextVersion: 4,
    });
    expect(repository.appendSessionEvent).toHaveBeenCalledWith({
      sessionId: 7,
      eventType: "context.patch.created",
      payload: {
        patchId: 701,
        sourceId: 61,
        baseContextVersion: 4,
        artifactUri:
          "file:///workspace/compose/7/context/patches/source-61-task-501.json",
      },
      actorType: "system",
      actorId: "source_distillation",
      agentTaskId: 501,
      contextVersion: 4,
    });
    expect(repository.appendSessionEvent).toHaveBeenCalledWith({
      sessionId: 7,
      eventType: "source.distillation.completed",
      payload: {
        sourceId: 61,
        patchId: 701,
        mergeTaskId: 801,
        artifactUri:
          "file:///workspace/compose/7/context/patches/source-61-task-501.json",
      },
      actorType: "system",
      actorId: "source_distillation",
      agentTaskId: 501,
      contextVersion: 4,
    });
  });

  it("can build the source distillation patch through the LLM gateway", async () => {
    const llmPatch = {
      facts: [
        {
          text: "Invoice exports are owned by BillingExportService.",
          evidence: [
            {
              sourceId: 61,
              uri: "file:///workspace/generated/code-research.md",
            },
          ],
          confidence: "high",
        },
      ],
      implementationFindings: [
        {
          file: "src/billing/BillingExportService.ts",
          finding: "Exports are written through the billing queue.",
          evidence: [{ sourceId: 61 }],
          confidence: "medium",
        },
      ],
      requirements: [
        {
          text: "Must preserve invoice export ordering.",
          evidence: [{ sourceId: 61 }],
          confidence: "medium",
        },
      ],
      constraints: [],
      decisions: [],
      openQuestions: [
        {
          text: "Which queue processes invoice export retries?",
          sourceId: 61,
        },
      ],
      risks: [],
      conflicts: [],
    };
    const repository = {
      getSession: vi.fn().mockResolvedValue({
        id: 7,
        workspacePath: "/workspace/compose/7",
      }),
      getSessionSource: vi.fn().mockResolvedValue(sourceSummary()),
      createReadyContextPatch: vi.fn().mockResolvedValue(701),
      enqueueContextMergeTaskIfNeeded: vi.fn().mockResolvedValue(801),
      appendSessionEvent: vi.fn().mockResolvedValue({ id: 950 }),
    };
    const workspace = {
      writeArtifact: vi.fn().mockResolvedValue({
        artifactUri:
          "file:///workspace/compose/7/context/patches/source-61-task-501.json",
        relativePath: "context/patches/source-61-task-501.json",
        bytes: 512,
        sha256: "b".repeat(64),
      }),
    };
    const llmGateway = {
      generateObject: vi.fn().mockResolvedValue(llmPatch),
    };
    const executor = new SourceDistillationExecutor(
      repository as never,
      workspace,
      { llmGateway, maxCostUsd: 0.4, timeoutMs: 30_000 },
    );

    await expect(executor.execute(claimedTask())).resolves.toMatchObject({
      output: { patchId: 701, mergeTaskId: 801, sourceId: 61 },
      contextVersionUsed: 4,
    });

    expect(llmGateway.generateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 7,
        agentTaskId: 501,
        purpose: "source_distillation",
        promptVersion: "source_distillation@v2",
        contextVersionUsed: 4,
        maxCostUsd: 0.4,
        timeoutMs: 30_000,
      }),
    );
    const artifactBody = JSON.parse(
      String(workspace.writeArtifact.mock.calls[0][0].content),
    );
    expect(artifactBody).toMatchObject({
      schemaVersion: 4,
      kind: "source_distillation",
      provenance: { sourceId: 61 },
    });
    expect(artifactBody.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          section: "facts",
          item: expect.objectContaining(llmPatch.facts[0]),
        }),
        expect.objectContaining({
          section: "requirements",
          item: expect.objectContaining(llmPatch.requirements[0]),
        }),
      ]),
    );
    expect(repository.createReadyContextPatch).toHaveBeenCalledWith(
      expect.objectContaining({
        patch: expect.objectContaining({
          schemaVersion: 4,
          kind: "source_distillation",
          provenance: expect.objectContaining({ sourceId: 61 }),
        }),
        patchUri:
          "file:///workspace/compose/7/context/patches/source-61-task-501.json",
      }),
    );
  });

  it("bounds a multi-chunk source patch before schema validation", async () => {
    const chunks = Array.from({ length: 4 }, (_, index) => ({
      id: 900 + index,
      sourceRevisionId: 601,
      chunkIndex: index,
      content: `chunk ${index}`,
      artifactUri: `file:///workspace/chunk-${index}.md`,
      contentSha256: String(index).repeat(64),
    }));
    let callIndex = 0;
    const llmGateway = {
      generateObject: vi.fn().mockImplementation(async () => {
        const prefix = `chunk-${callIndex++}`;
        return {
          facts: Array.from({ length: 200 }, (_, index) => ({
            text: `${prefix} fact ${index}`,
          })),
          implementationFindings: [],
          requirements: Array.from({ length: 200 }, (_, index) => ({
            text: `${prefix} requirement ${index}`,
          })),
          constraints: [],
          decisions: [],
          openQuestions: [],
          risks: [],
          conflicts: [],
        };
      }),
    };
    const repository = {
      getSession: vi.fn().mockResolvedValue({
        id: 7,
        workspacePath: "/workspace/compose/7",
      }),
      getSessionSource: vi
        .fn()
        .mockResolvedValue(sourceSummary({ currentRevisionId: 601 })),
      listSourceChunks: vi.fn().mockResolvedValue(chunks),
      createReadyContextPatch: vi.fn().mockResolvedValue(701),
      enqueueContextMergeTaskIfNeeded: vi.fn().mockResolvedValue(801),
      appendSessionEvent: vi.fn().mockResolvedValue({ id: 950 }),
    };
    const workspace = {
      writeArtifact: vi.fn().mockResolvedValue({
        artifactUri:
          "file:///workspace/compose/7/context/patches/source-61-task-501.json",
        relativePath: "context/patches/source-61-task-501.json",
        bytes: 512,
        sha256: "b".repeat(64),
      }),
    };
    const executor = new SourceDistillationExecutor(
      repository as never,
      workspace,
      { llmGateway },
    );

    await expect(executor.execute(claimedTask())).resolves.toMatchObject({
      output: {
        patchId: 701,
        compaction: {
          droppedItemsBySection: { requirements: 550, facts: 550 },
        },
      },
    });

    const artifactBody = JSON.parse(
      String(workspace.writeArtifact.mock.calls[0][0].content),
    );
    expect(artifactBody.operations).toHaveLength(500);
    expect(
      artifactBody.operations.filter(
        (operation: { section: string }) => operation.section === "facts",
      ),
    ).toHaveLength(250);
    expect(
      artifactBody.operations.filter(
        (operation: { section: string }) =>
          operation.section === "requirements",
      ),
    ).toHaveLength(250);
    expect(repository.createReadyContextPatch).toHaveBeenCalledWith(
      expect.objectContaining({ patch: artifactBody }),
    );
  });

  it("context merge writes working-context artifacts and publishes context.updated", async () => {
    const repository = {
      getSession: vi.fn().mockResolvedValue({
        id: 7,
        workspacePath: "/workspace/compose/7",
      }),
      listReadyContextPatches: vi.fn().mockResolvedValue([
        {
          id: 701,
          sessionId: 7,
          sourceId: 61,
          agentTaskId: 501,
          baseContextVersion: 4,
          patch: {
            facts: [
              {
                text: "Billing export research",
                evidence: [{ sourceId: 61 }],
                confidence: "high",
              },
            ],
            openQuestions: [
              {
                question: "Which queue processes invoices?",
                sourceId: 61,
              },
            ],
            conflicts: [
              {
                text: "Research says Billing owns exports, but prior context says Finance owns exports.",
                evidence: [{ sourceId: 61 }],
                confidence: "medium",
              },
            ],
          },
        },
      ]),
      beginContextVersionBuild: vi.fn().mockResolvedValue({
        contextVersionId: 901,
        version: 5,
        parentVersion: 4,
      }),
      getContextProjection: vi.fn().mockResolvedValue(contextProjection()),
      commitContextVersion: vi.fn().mockResolvedValue(true),
      appendSessionEvent: vi.fn().mockResolvedValue({ id: 950 }),
    };
    const workspace = {
      writeArtifact: vi
        .fn()
        .mockResolvedValueOnce({
          artifactUri:
            "file:///workspace/compose/7/context/versions/working-context-v5.md",
          relativePath: "context/versions/working-context-v5.md",
          bytes: 1024,
          sha256: "c".repeat(64),
        })
        .mockResolvedValueOnce({
          artifactUri:
            "file:///workspace/compose/7/context/versions/working-context-v5.json",
          relativePath: "context/versions/working-context-v5.json",
          bytes: 512,
          sha256: "d".repeat(64),
        }),
    };
    const executor = new ContextMergeExecutor(repository as never, workspace);

    await expect(
      executor.execute(
        claimedTask({
          id: 801,
          capability: "context_merge",
          executorType: "context_merge",
          input: { sessionId: 7, triggerPatchId: 701 },
        }),
      ),
    ).resolves.toEqual({
      output: {
        contextVersion: 5,
        contextVersionId: 901,
        patchIds: [700, 701],
        artifactUri:
          "file:///workspace/compose/7/context/versions/working-context-v5.md",
        structuredArtifactUri:
          "file:///workspace/compose/7/context/versions/working-context-v5.json",
      },
      contextVersionUsed: 5,
    });

    expect(workspace.writeArtifact).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        workspacePath: "/workspace/compose/7",
        relativePath: "context/versions/working-context-v5.md",
      }),
    );
    expect(String(workspace.writeArtifact.mock.calls[0][0].content)).toContain(
      "## Known Facts",
    );
    expect(String(workspace.writeArtifact.mock.calls[0][0].content)).toContain(
      "## Conflicts",
    );
    expect(String(workspace.writeArtifact.mock.calls[0][0].content)).toContain(
      "Research says Billing owns exports",
    );
    const structuredContext = JSON.parse(
      String(workspace.writeArtifact.mock.calls[1][0].content),
    );
    expect(structuredContext.conflicts).toEqual([
      expect.objectContaining({
        text: "Research says Billing owns exports, but prior context says Finance owns exports.",
        evidence: [{ sourceId: 61 }],
        confidence: "medium",
      }),
    ]);
    expect(structuredContext.facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: "Finance owns reconciliation" }),
        expect.objectContaining({ text: "Billing export research" }),
      ]),
    );
    expect(repository.commitContextVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 7,
        contextVersionId: 901,
        version: 5,
        patchIds: [700, 701],
        artifactSha256: "c".repeat(64),
        artifactBytes: 1024,
        conflicts: [
          expect.objectContaining({
            text: "Research says Billing owns exports, but prior context says Finance owns exports.",
            evidence: [{ sourceId: 61 }],
            confidence: "medium",
          }),
        ],
      }),
    );
    expect(repository.appendSessionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 7,
        eventType: "context.merge.started",
        agentTaskId: 801,
      }),
    );
    expect(repository.appendSessionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 7,
        eventType: "context.updated",
        contextVersion: 5,
        agentTaskId: 801,
      }),
    );
  });

  it("can assist context merge through the LLM gateway without trusting identity fields", async () => {
    const llmContext = {
      objective: "Ship invoice export ordering",
      problemStatement: "Invoice export retries must preserve queue order.",
      solution: "Preserve user-visible export ordering across retries.",
      businessRequirements: [
        "Billing audits must receive exports in the requested order.",
      ],
      functionalRequirements: [
        "Users can retry an export without changing invoice order.",
      ],
      challenges: ["Retry behavior must remain observable."],
      stories: [
        {
          id: "story-retry-order",
          title: "Retry invoice exports",
          userStory:
            "As a billing analyst, I want retries to preserve invoice order, so that audits remain reliable.",
          businessValue: "Prevents inconsistent billing audit evidence.",
          acceptanceCriteria: ["The retried export preserves invoice order"],
          sequence: 0,
        },
      ],
      facts: [
        {
          text: "BillingExportService owns invoice export ordering.",
          evidence: [{ sourceId: 61 }],
          confidence: "high",
        },
      ],
      implementationFindings: [],
      requirements: [],
      constraints: [],
      decisions: [],
      openQuestions: [],
      conflicts: [
        {
          text: "Prior context named Finance as owner.",
          evidence: [{ sourceId: 61 }],
          confidence: "medium",
        },
      ],
      risks: [],
      recommendedNextActions: ["Verify retry queue ownership."],
      patchIds: [999],
      sources: [999],
      version: 99,
      parentVersion: 98,
    };
    const repository = {
      getSession: vi.fn().mockResolvedValue({
        id: 7,
        workspacePath: "/workspace/compose/7",
      }),
      listReadyContextPatches: vi.fn().mockResolvedValue([
        {
          id: 701,
          sessionId: 7,
          sourceId: 61,
          agentTaskId: 501,
          baseContextVersion: 4,
          patch: {
            facts: [
              {
                text: "Billing export research",
                evidence: [{ sourceId: 61 }],
                confidence: "high",
              },
            ],
          },
        },
      ]),
      beginContextVersionBuild: vi.fn().mockResolvedValue({
        contextVersionId: 901,
        version: 5,
        parentVersion: 4,
      }),
      getContextProjection: vi
        .fn()
        .mockResolvedValue(
          contextProjection({ facts: [], sourceIds: [], patchIds: [] }),
        ),
      commitContextVersion: vi.fn().mockResolvedValue(true),
      appendSessionEvent: vi.fn().mockResolvedValue({ id: 950 }),
    };
    const workspace = {
      writeArtifact: vi
        .fn()
        .mockResolvedValueOnce({
          artifactUri:
            "file:///workspace/compose/7/context/versions/working-context-v5.md",
          relativePath: "context/versions/working-context-v5.md",
          bytes: 1024,
          sha256: "c".repeat(64),
        })
        .mockResolvedValueOnce({
          artifactUri:
            "file:///workspace/compose/7/context/versions/working-context-v5.json",
          relativePath: "context/versions/working-context-v5.json",
          bytes: 512,
          sha256: "d".repeat(64),
        }),
    };
    const llmGateway = {
      generateObject: vi.fn().mockResolvedValue(llmContext),
    };
    const executor = new ContextMergeExecutor(repository as never, workspace, {
      llmGateway,
      maxCostUsd: 0.5,
      timeoutMs: 45_000,
    });

    await expect(
      executor.execute(
        claimedTask({
          id: 801,
          capability: "context_merge",
          executorType: "context_merge",
          input: { sessionId: 7, triggerPatchId: 701 },
        }),
      ),
    ).resolves.toMatchObject({
      output: { contextVersion: 5, contextVersionId: 901, patchIds: [701] },
      contextVersionUsed: 5,
    });

    expect(llmGateway.generateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 7,
        agentTaskId: 801,
        purpose: "context_merge",
        promptVersion: "context_merge@v1",
        contextVersionUsed: 4,
        maxCostUsd: 0.5,
        timeoutMs: 45_000,
      }),
    );
    const directJsonSchema = llmGateway.generateObject.mock.calls[0][0]
      .directJsonSchema as Record<string, unknown>;
    expect(JSON.stringify(directJsonSchema)).not.toContain('"minimum"');
    expect(String(workspace.writeArtifact.mock.calls[0][0].content)).toContain(
      "Ship invoice export ordering",
    );
    const structuredContext = JSON.parse(
      String(workspace.writeArtifact.mock.calls[1][0].content),
    );
    expect(structuredContext).toMatchObject({
      objective: "Ship invoice export ordering",
      solution: "Preserve user-visible export ordering across retries.",
      version: 5,
      parentVersion: 4,
      patchIds: [701],
      sources: [61],
    });
    expect(structuredContext.stories[0].acceptanceCriteria[0]).toMatch(
      /^Scenario:[\s\S]*^Given[\s\S]*^When[\s\S]*^Then/m,
    );
    expect(repository.commitContextVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: expect.objectContaining({
          objective: "Ship invoice export ordering",
        }),
        conflicts: [],
        patchIds: [701],
        sourceIds: [61],
      }),
    );
  });

  it("commits the deterministic context when LLM refinement times out", async () => {
    const repository = {
      getSession: vi.fn().mockResolvedValue({
        id: 7,
        workspacePath: "/workspace/compose/7",
      }),
      listReadyContextPatches: vi.fn().mockResolvedValue([
        {
          id: 701,
          sessionId: 7,
          sourceId: 61,
          agentTaskId: 501,
          baseContextVersion: 4,
          patch: {
            facts: [
              {
                text: "Billing export research",
                evidence: [{ sourceId: 61 }],
                confidence: "high",
              },
            ],
          },
        },
      ]),
      beginContextVersionBuild: vi.fn().mockResolvedValue({
        contextVersionId: 901,
        version: 5,
        parentVersion: 4,
      }),
      getContextProjection: vi.fn().mockResolvedValue(contextProjection()),
      commitContextVersion: vi.fn().mockResolvedValue(true),
      failContextVersionBuild: vi.fn().mockResolvedValue(undefined),
      appendSessionEvent: vi.fn().mockResolvedValue({ id: 950 }),
    };
    const workspace = {
      writeArtifact: vi
        .fn()
        .mockResolvedValueOnce({
          artifactUri:
            "file:///workspace/compose/7/context/versions/working-context-v5.md",
          relativePath: "context/versions/working-context-v5.md",
          bytes: 1024,
          sha256: "c".repeat(64),
        })
        .mockResolvedValueOnce({
          artifactUri:
            "file:///workspace/compose/7/context/versions/working-context-v5.json",
          relativePath: "context/versions/working-context-v5.json",
          bytes: 512,
          sha256: "d".repeat(64),
        }),
    };
    const executor = new ContextMergeExecutor(repository as never, workspace, {
      llmGateway: {
        generateObject: vi
          .fn()
          .mockRejectedValue(new Error("SDK timeout after 120000ms")),
      },
    });

    await expect(
      executor.execute(
        claimedTask({
          id: 801,
          capability: "context_merge",
          executorType: "context_merge",
          input: { sessionId: 7, triggerPatchId: 701 },
        }),
      ),
    ).resolves.toMatchObject({
      output: {
        contextVersion: 5,
        contextVersionId: 901,
        llmRefinement: "degraded",
      },
      contextVersionUsed: 5,
    });

    expect(repository.commitContextVersion).toHaveBeenCalledTimes(1);
    expect(repository.failContextVersionBuild).not.toHaveBeenCalled();
    expect(repository.appendSessionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 7,
        eventType: "context.merge.degraded",
        payload: expect.objectContaining({
          fallback: "deterministic_merge",
          errorCode: "llm_timeout",
        }),
      }),
    );
    expect(repository.appendSessionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 7,
        eventType: "context.updated",
      }),
    );
  });

  it("compacts aggregate context overflow across source provenance", async () => {
    const sourcePatch = (sourceId: number) => ({
      schemaVersion: 4 as const,
      kind: "source_distillation" as const,
      provenance: { sourceId },
      operations: Array.from({ length: 300 }, (_, index) => ({
        op: "upsert" as const,
        section: "facts" as const,
        item: { text: `Source ${sourceId} fact ${index}` },
      })),
    });
    const repository = {
      getSession: vi.fn().mockResolvedValue({
        id: 7,
        workspacePath: "/workspace/compose/7",
      }),
      listReadyContextPatches: vi.fn().mockResolvedValue([
        {
          id: 701,
          sessionId: 7,
          sourceId: 61,
          agentTaskId: 501,
          baseContextVersion: null,
          patch: sourcePatch(61),
        },
        {
          id: 702,
          sessionId: 7,
          sourceId: 62,
          agentTaskId: 502,
          baseContextVersion: null,
          patch: sourcePatch(62),
        },
      ]),
      beginContextVersionBuild: vi.fn().mockResolvedValue({
        contextVersionId: 901,
        version: 1,
        parentVersion: null,
      }),
      getContextProjection: vi.fn(),
      commitContextVersion: vi.fn().mockResolvedValue(true),
      failContextVersionBuild: vi.fn().mockResolvedValue(true),
      appendSessionEvent: vi.fn().mockResolvedValue({ id: 950 }),
    };
    const workspace = {
      writeArtifact: vi
        .fn()
        .mockResolvedValueOnce({
          artifactUri:
            "file:///workspace/compose/7/context/versions/working-context-v1.md",
          relativePath: "context/versions/working-context-v1.md",
          bytes: 1024,
          sha256: "c".repeat(64),
        })
        .mockResolvedValueOnce({
          artifactUri:
            "file:///workspace/compose/7/context/versions/working-context-v1.json",
          relativePath: "context/versions/working-context-v1.json",
          bytes: 512,
          sha256: "d".repeat(64),
        }),
    };
    const executor = new ContextMergeExecutor(repository as never, workspace);

    await expect(
      executor.execute(
        claimedTask({
          id: 801,
          capability: "context_merge",
          executorType: "context_merge",
          input: { sessionId: 7 },
        }),
      ),
    ).resolves.toMatchObject({
      output: {
        contextVersion: 1,
        compaction: { droppedItemsBySection: { facts: 100 } },
      },
    });

    const structuredContext = JSON.parse(
      String(workspace.writeArtifact.mock.calls[1][0].content),
    );
    expect(structuredContext.facts).toHaveLength(500);
    const sourceCounts = structuredContext.facts.reduce(
      (
        counts: Record<string, number>,
        fact: { provenance: { sourceId: number } },
      ) => {
        const sourceId = String(fact.provenance.sourceId);
        counts[sourceId] = (counts[sourceId] ?? 0) + 1;
        return counts;
      },
      {},
    );
    expect(sourceCounts).toEqual({ "61": 250, "62": 250 });
    expect(repository.failContextVersionBuild).not.toHaveBeenCalled();
  });

  it("marks a reserved context version failed when artifact writing throws", async () => {
    const repository = {
      getSession: vi.fn().mockResolvedValue({
        id: 7,
        workspacePath: "/workspace/compose/7",
      }),
      listReadyContextPatches: vi.fn().mockResolvedValue([
        {
          id: 701,
          sessionId: 7,
          sourceId: 61,
          agentTaskId: 501,
          baseContextVersion: null,
          patch: { facts: [{ text: "Billing owns exports" }] },
        },
      ]),
      beginContextVersionBuild: vi.fn().mockResolvedValue({
        contextVersionId: 901,
        version: 1,
        parentVersion: null,
      }),
      getContextProjection: vi.fn(),
      commitContextVersion: vi.fn(),
      failContextVersionBuild: vi.fn().mockResolvedValue(true),
      appendSessionEvent: vi.fn().mockResolvedValue({ id: 950 }),
    };
    const workspace = {
      writeArtifact: vi
        .fn()
        .mockRejectedValue(new Error("EACCES: permission denied")),
    };
    const executor = new ContextMergeExecutor(repository as never, workspace);

    await expect(
      executor.execute(
        claimedTask({
          id: 801,
          capability: "context_merge",
          executorType: "context_merge",
          input: { sessionId: 7 },
        }),
      ),
    ).rejects.toThrow("EACCES: permission denied");

    expect(repository.failContextVersionBuild).toHaveBeenCalledWith({
      sessionId: 7,
      contextVersionId: 901,
      version: 1,
      errorMessage: "EACCES: permission denied",
    });
    expect(repository.commitContextVersion).not.toHaveBeenCalled();
  });

  it("default context registry wires source_distillation and context_merge", () => {
    const registry = createContextExecutorRegistry({} as never, {} as never);

    expect(registry.listExecutorTypes()).toEqual([
      "source_distillation",
      "context_merge",
    ]);
  });
});
