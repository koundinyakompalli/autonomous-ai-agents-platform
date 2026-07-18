import { describe, expect, it, vi } from "vitest";
import {
  ChatCoordinator,
  buildCoordinatorContextBundle,
  resolveCoordinatorMaxTasksPerTurn,
  validateCoordinatorDecision,
} from "./chat-coordinator.js";
import type {
  ComposeSessionMessageSummary,
  ComposeSessionSourceSummary,
  ComposeSessionSummary,
} from "../compose-types.js";
import type { LlmGateway } from "../llm/llm-gateway.js";

function sessionFixture(
  overrides: Partial<ComposeSessionSummary> = {},
): ComposeSessionSummary {
  return {
    id: 7,
    name: "Checkout retry handling",
    createdBy: "alice",
    createdByDisplay: "Alice",
    status: "draft",
    claudeSessionId: null,
    sourceId: null,
    readiness: {
      ready: false,
      openQuestions: [],
      summary: "Need to verify retry ownership.",
    },
    s3Prefix: "compose/7/",
    workspacePath: "/workspace/session-7",
    sourceCount: 3,
    passwordProtected: false,
    latestContextVersion: 4,
    contextStatus: "clean",
    createdAt: "2026-06-18T00:00:00.000Z",
    updatedAt: "2026-06-18T00:00:00.000Z",
    ...overrides,
  };
}

function messageFixture(
  id: number,
  role: ComposeSessionMessageSummary["role"],
  content: string,
): ComposeSessionMessageSummary {
  return {
    id,
    sessionId: 7,
    role,
    content,
    createdAt: `2026-06-18T00:00:0${id}.000Z`,
  };
}

function sourceFixture(
  overrides: Partial<ComposeSessionSourceSummary> = {},
): ComposeSessionSourceSummary {
  return {
    id: 21,
    sessionId: 7,
    requestId: null,
    kind: "file",
    originalFilename: "requirements.md",
    mimeType: "text/markdown",
    sizeBytes: 1200,
    sourceUrl: null,
    s3KeyRaw: "compose/7/raw/requirements.md",
    converter: "markitdown",
    markdownPath: "compose/7/converted/requirements.md",
    markdownContent: "# Requirements",
    conversionStatus: "converted",
    conversionStartedAt: null,
    conversionAttempts: 1,
    conversionLeaseExpiresAt: null,
    errorMessage: null,
    createdAt: "2026-06-18T00:00:00.000Z",
    updatedAt: "2026-06-18T00:00:00.000Z",
    ...overrides,
  };
}

describe("coordinator decision validation", () => {
  it("accepts answer decisions with the context version used", () => {
    expect(
      validateCoordinatorDecision({
        action: "answer",
        answer: "Retry handling is in compose-database.ts.",
        confidence: "high",
        contextVersionUsed: 4,
      }),
    ).toEqual({
      action: "answer",
      answer: "Retry handling is in compose-database.ts.",
      confidence: "high",
      contextVersionUsed: 4,
    });
  });

  it("accepts answer decisions without LLM-authored provenance", () => {
    expect(
      validateCoordinatorDecision({
        action: "answer",
        answer: "Retry handling is in compose-database.ts.",
        confidence: "high",
      }),
    ).toEqual({
      action: "answer",
      answer: "Retry handling is in compose-database.ts.",
      confidence: "high",
    });
  });

  it("accepts grounded brief metadata on answer decisions", () => {
    expect(
      validateCoordinatorDecision({
        action: "answer",
        answer: "The ticket belongs to Core App.",
        confidence: "high",
        details: {
          module: "Provider Disputes",
          repositories: ["cp-medhok-monorepo"],
          difficulty: "M",
          loeHours: 60,
          storyPoints: 8,
        },
      }),
    ).toMatchObject({
      action: "answer",
      details: {
        module: "Provider Disputes",
        repositories: ["cp-medhok-monorepo"],
        loeHours: 60,
      },
    });
  });

  it("rejects research fanout above the configured cap", () => {
    expect(() =>
      validateCoordinatorDecision(
        {
          action: "dispatch_research",
          userVisibleStatus: "Checking implementation details",
          synthesisInstructions: "Summarize with file evidence.",
          researchTasks: [
            {
              capability: "code_research",
              question: "Where is retry implemented?",
              requiredEvidence: true,
              maxCostUsd: 1,
            },
            {
              capability: "config_research",
              question: "Which flag enables it?",
              requiredEvidence: true,
              maxCostUsd: 1,
            },
          ],
        },
        { maxResearchTasks: 1 },
      ),
    ).toThrow("coordinator_decision_rejected:max_research_tasks");
  });

  it("resolves the research task cap from env-compatible strings", () => {
    expect(resolveCoordinatorMaxTasksPerTurn(undefined)).toBe(3);
    expect(resolveCoordinatorMaxTasksPerTurn("5")).toBe(5);
    expect(resolveCoordinatorMaxTasksPerTurn("0")).toBe(3);
    expect(resolveCoordinatorMaxTasksPerTurn("not-a-number")).toBe(3);
  });
});

describe("ChatCoordinator", () => {
  it("requests a structured decision from the LLM gateway", async () => {
    const decision = {
      action: "answer" as const,
      answer: "Retry handling is implemented in compose-database.ts.",
      confidence: "high" as const,
      contextVersionUsed: 99,
    };
    const llmGateway = fakeLlmGateway(decision);
    const coordinator = new ChatCoordinator(llmGateway, {
      maxResearchTasks: 2,
    });
    const bundle = coordinatorBundleFixture();

    await expect(coordinator.decide(bundle)).resolves.toEqual({
      ...decision,
      contextVersionUsed: 4,
    });

    expect(llmGateway.generateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 7,
        purpose: "chat_coordinator_fast",
        promptVersion: "chat_coordinator@v2",
        contextVersionUsed: 4,
        schema: expect.anything(),
        jsonSchema: expect.objectContaining({
          type: "object",
          properties: expect.objectContaining({
            action: {
              enum: [
                "answer",
                "dispatch_research",
                "ask_clarification",
                "escalate",
              ],
            },
          }),
          required: ["action"],
        }),
        directJsonSchema: expect.objectContaining({
          type: "object",
          required: ["action"],
        }),
      }),
    );
    const jsonSchema = llmGateway.generateObject.mock.calls[0]?.[0].jsonSchema;
    const directJsonSchema =
      llmGateway.generateObject.mock.calls[0]?.[0].directJsonSchema;
    expect(jsonSchema?.properties).not.toHaveProperty("contextVersionUsed");
    expect(jsonSchema).not.toHaveProperty("oneOf");
    expect(jsonSchema).not.toHaveProperty("anyOf");
    expect(jsonSchema).not.toHaveProperty("allOf");
    expect(JSON.stringify(directJsonSchema)).not.toContain('"oneOf"');
    expect(JSON.stringify(directJsonSchema)).not.toContain('"anyOf"');
    expect(JSON.stringify(directJsonSchema)).not.toContain('"allOf"');
    expect(JSON.stringify(jsonSchema)).toContain('"exclusiveMinimum":0');
    expect(JSON.stringify(directJsonSchema)).not.toContain(
      '"exclusiveMinimum"',
    );
    const request = llmGateway.generateObject.mock.calls[0]?.[0];
    const prompt = request?.prompt ?? "";
    expect(prompt).toContain("You are the Spec Factory Chat Coordinator.");
    expect(request?.system).toContain("# Standard MHK organizational context");
    expect(request?.system).toContain("## 0. Agent operating contract");
    expect(request).toMatchObject({ cacheSystem: true, cacheTtl: "1h" });
    expect(prompt).toContain('"userMessage": "Where is retry implemented?"');
    expect(prompt).toContain('"capabilities"');
    expect(prompt).toContain('"code_research"');
  });

  it("uses a supplied organizational context provider at the prompt boundary", async () => {
    const llmGateway = fakeLlmGateway({
      action: "answer",
      answer: "Ready.",
      confidence: "high",
    });
    const organizationalContextProvider = vi
      .fn()
      .mockReturnValue("MHK TEST ORGANIZATIONAL CONTEXT");
    const coordinator = new ChatCoordinator(llmGateway, {
      organizationalContextProvider,
    });

    await coordinator.decide(coordinatorBundleFixture());

    expect(organizationalContextProvider).toHaveBeenCalledWith(
      expect.stringContaining("Where is retry implemented?"),
    );
    expect(llmGateway.generateObject.mock.calls[0]?.[0].system).toContain(
      "MHK TEST ORGANIZATIONAL CONTEXT",
    );
  });

  it("retries a code-research decision when the user asked to inspect attached Jira evidence", async () => {
    const llmGateway = fakeLlmGateway({
      action: "dispatch_research",
      userVisibleStatus: "Checking the codebase",
      researchTasks: [
        {
          capability: "code_research",
          question: "Inspect the Jira issue",
          requiredEvidence: true,
          maxCostUsd: 1,
        },
      ],
      synthesisInstructions: "Return the findings.",
    });
    llmGateway.generateObject.mockResolvedValueOnce({
      action: "dispatch_research",
      userVisibleStatus: "Checking the codebase",
      researchTasks: [
        {
          capability: "code_research",
          question: "Inspect the Jira issue",
          requiredEvidence: true,
          maxCostUsd: 1,
        },
      ],
      synthesisInstructions: "Return the findings.",
    });
    llmGateway.generateObject.mockResolvedValueOnce({
      action: "answer",
      answer: "CPSR-1100 identifies P32Health and a 60-hour LOE.",
      confidence: "high",
      details: { module: "P32Health", loeHours: 60 },
    });
    const coordinator = new ChatCoordinator(llmGateway);

    await expect(
      coordinator.decide({
        ...coordinatorBundleFixture(),
        userMessage: "Check the JIRA tickets and answer the questions.",
        attachedSources: [
          {
            sourceId: 206,
            kind: "jira",
            filename: "CPSR-1100",
            summary: "P32Health LOE request",
            entities: {
              jiraKeys: ["CPSR-1100"],
              repositories: [],
              files: [],
              clients: [],
              loeHours: [60],
              dates: [],
              assumptions: [],
            },
            markdownContent: "# CPSR-1100\n\nModule: P32Health\nLOE: 60",
          },
        ],
      }),
    ).resolves.toMatchObject({
      action: "answer",
      answer: expect.stringContaining("CPSR-1100"),
      details: { module: "P32Health", loeHours: 60 },
    });

    expect(llmGateway.generateObject).toHaveBeenCalledTimes(2);
    expect(llmGateway.generateObject.mock.calls[1]?.[0].prompt).toContain(
      "Read attachedSources and answer from that evidence now",
    );
  });

  it("validates gateway research decisions against the configured fanout cap", async () => {
    const llmGateway = fakeLlmGateway({
      action: "dispatch_research",
      userVisibleStatus: "Checking implementation details",
      synthesisInstructions: "Return file-backed evidence.",
      researchTasks: [
        {
          capability: "code_research",
          question: "Where is retry implemented?",
          requiredEvidence: true,
          maxCostUsd: 1,
        },
        {
          capability: "config_research",
          question: "Which flag enables it?",
          requiredEvidence: true,
          maxCostUsd: 1,
        },
      ],
    });
    const coordinator = new ChatCoordinator(llmGateway, {
      maxResearchTasks: 1,
    });

    await expect(
      coordinator.decide(coordinatorBundleFixture()),
    ).rejects.toThrow("coordinator_decision_rejected:max_research_tasks");
  });

  it("returns clarification decisions from structured gateway output", async () => {
    const decision = {
      action: "ask_clarification" as const,
      question: "Which member roles need access to the export?",
      reason: "The affected business users are not yet defined.",
      expiresAt: "2026-06-18T01:00:00.000Z",
    };
    const llmGateway = fakeLlmGateway(decision);
    const coordinator = new ChatCoordinator(llmGateway);

    await expect(
      coordinator.decide(coordinatorBundleFixture()),
    ).resolves.toEqual(decision);
  });
});

describe("buildCoordinatorContextBundle", () => {
  it("builds a backend-owned bundle from session, messages, sources, and capabilities", async () => {
    const repository = {
      getSession: vi.fn().mockResolvedValue(sessionFixture()),
      listMessages: vi
        .fn()
        .mockResolvedValue([
          messageFixture(1, "user", "First question"),
          messageFixture(2, "assistant", "First answer"),
          messageFixture(3, "user", "Where is retry implemented?"),
        ]),
      listSessionSources: vi.fn().mockResolvedValue([
        sourceFixture({ id: 21, kind: "file", conversionStatus: "converted" }),
        sourceFixture({
          id: 22,
          kind: "generated_research",
          sourceOrigin: "agent",
          conversionStatus: "converted",
        }),
        sourceFixture({ id: 23, kind: "jira", conversionStatus: "failed" }),
      ]),
      getContextProjection: vi
        .fn()
        .mockResolvedValue(contextProjectionFixture()),
    };

    const bundle = await buildCoordinatorContextBundle(repository, {
      sessionId: 7,
      userMessage: "Where is retry implemented?",
      requestedContextVersion: 3,
      maxRecentMessages: 2,
      capabilities: [
        {
          name: "code_research",
          executorType: "code_research",
          queue: "research",
          defaultPriority: 70,
          maxRuntimeSeconds: 600,
          maxAttempts: 2,
          requiresWorkspace: true,
          requiresContextVersion: true,
          producesGeneratedSource: true,
        },
      ],
    });

    expect(bundle).toMatchObject({
      sessionId: 7,
      userMessage: "Where is retry implemented?",
      requestedContextVersion: 3,
      contextVersionUsed: 4,
      workingContextStructured: { sessionId: 7, version: 4 },
      conversationSummary: "Need to verify retry ownership.",
      recentMessages: [
        { id: 2, role: "assistant", content: "First answer" },
        { id: 3, role: "user", content: "Where is retry implemented?" },
      ],
      sourceStatus: {
        total: 3,
        convertedSourceIds: [21, 22],
        failedSourceIds: [23],
        generatedResearchSourceIds: [22],
        byKind: {
          file: 1,
          generated_research: 1,
          jira: 1,
        },
        byConversionStatus: {
          converted: 2,
          failed: 1,
        },
      },
      generatedResearch: [
        {
          sourceId: 22,
          filename: "requirements.md",
          markdownContent: "# Requirements",
          contextVersionUsed: null,
        },
      ],
      attachedSources: [
        expect.objectContaining({
          sourceId: 21,
          kind: "file",
          filename: "requirements.md",
          markdownContent: "# Requirements",
        }),
      ],
      pendingTasks: [],
      capabilities: [{ name: "code_research" }],
    });
    expect(bundle.workingContextMarkdown).toContain("# Working Context v4");
    expect(bundle.workingContextMarkdown).toContain("Retries are persisted");
    expect(repository.getContextProjection).toHaveBeenCalledWith(7, 4);
  });

  it("fails closed when the frozen context version cannot be loaded", async () => {
    const repository = {
      getSession: vi.fn().mockResolvedValue(sessionFixture()),
      listMessages: vi.fn().mockResolvedValue([]),
      listSessionSources: vi.fn().mockResolvedValue([]),
      getContextProjection: vi.fn().mockResolvedValue(null),
    };

    await expect(
      buildCoordinatorContextBundle(repository, {
        sessionId: 7,
        userMessage: "Use the frozen context",
        contextVersionUsed: 4,
      }),
    ).rejects.toThrow("Compose context version 4 was not found for session 7");
  });

  it("includes bounded generated research markdown for synthesis", async () => {
    const longMarkdown = `${"Implementation note. ".repeat(900)}Final detail.`;
    const repository = {
      getSession: vi.fn().mockResolvedValue(sessionFixture()),
      listMessages: vi.fn().mockResolvedValue([]),
      listSessionSources: vi.fn().mockResolvedValue([
        sourceFixture({
          id: 31,
          kind: "generated_research",
          originalFilename: "code-research-task-501.md",
          sourceOrigin: "agent",
          generatedByTaskId: 501,
          contextVersionUsed: 4,
          artifactUri: "file:///research/code-research-task-501.md",
          markdownContent:
            "  # Research\n\nRetry lives in compose-database.ts.  ",
        }),
        sourceFixture({
          id: 32,
          kind: "generated_research",
          originalFilename: "code-research-task-502.md",
          sourceOrigin: "agent",
          generatedByTaskId: 502,
          contextVersionUsed: 4,
          markdownContent: longMarkdown,
        }),
        sourceFixture({
          id: 33,
          kind: "file",
          originalFilename: "requirements.md",
          markdownContent: "# Requirements",
        }),
        sourceFixture({
          id: 34,
          kind: "generated_research",
          originalFilename: "failed-research.md",
          sourceOrigin: "agent",
          conversionStatus: "failed",
          markdownContent: "# Failed research",
        }),
      ]),
      getContextProjection: vi
        .fn()
        .mockResolvedValue(contextProjectionFixture()),
    };

    const bundle = await buildCoordinatorContextBundle(repository, {
      sessionId: 7,
      userMessage: "Where is retry implemented?",
    });

    expect(bundle.generatedResearch).toHaveLength(2);
    expect(bundle.generatedResearch[0]).toEqual({
      sourceId: 31,
      filename: "code-research-task-501.md",
      markdownContent: "# Research\n\nRetry lives in compose-database.ts.",
      contextVersionUsed: 4,
      artifactUri: "file:///research/code-research-task-501.md",
    });
    expect(bundle.generatedResearch[1]?.markdownContent.length).toBeLessThan(
      longMarkdown.length,
    );
    expect(bundle.generatedResearch[1]?.markdownContent).toContain(
      "[truncated]",
    );

    const llmGateway = fakeLlmGateway({
      action: "answer",
      answer: "Retry lives in compose-database.ts.",
      confidence: "high",
      contextVersionUsed: 4,
    });
    const coordinator = new ChatCoordinator(llmGateway);
    await coordinator.decide(bundle);
    const prompt = llmGateway.generateObject.mock.calls[0]?.[0].prompt ?? "";
    expect(prompt).toContain('"generatedResearch"');
    expect(prompt).toContain("Retry lives in compose-database.ts.");
  });

  it("uses the session latest context as the requested version when the turn did not pin one", async () => {
    const repository = {
      getSession: vi.fn().mockResolvedValue(sessionFixture()),
      listMessages: vi.fn().mockResolvedValue([]),
      listSessionSources: vi.fn().mockResolvedValue([]),
      getContextProjection: vi
        .fn()
        .mockResolvedValue(contextProjectionFixture()),
    };

    await expect(
      buildCoordinatorContextBundle(repository, {
        sessionId: 7,
        userMessage: "What changed?",
      }),
    ).resolves.toMatchObject({
      requestedContextVersion: 4,
      contextVersionUsed: 4,
    });
  });

  it("rejects archived or missing sessions before building a bundle", async () => {
    const archivedRepository = {
      getSession: vi
        .fn()
        .mockResolvedValue(sessionFixture({ status: "archived" })),
      listMessages: vi.fn(),
      listSessionSources: vi.fn(),
      getContextProjection: vi.fn(),
    };
    await expect(
      buildCoordinatorContextBundle(archivedRepository, {
        sessionId: 7,
        userMessage: "Can you answer?",
      }),
    ).rejects.toThrow("Compose session 7 was not found");
    expect(archivedRepository.listMessages).not.toHaveBeenCalled();

    const missingRepository = {
      getSession: vi.fn().mockResolvedValue(null),
      listMessages: vi.fn(),
      listSessionSources: vi.fn(),
      getContextProjection: vi.fn(),
    };
    await expect(
      buildCoordinatorContextBundle(missingRepository, {
        sessionId: 7,
        userMessage: "Can you answer?",
      }),
    ).rejects.toThrow("Compose session 7 was not found");
  });
});

function coordinatorBundleFixture() {
  return {
    sessionId: 7,
    userMessage: "Where is retry implemented?",
    requestedContextVersion: 3,
    contextVersionUsed: 4,
    workingContextMarkdown: "Retry ownership belongs to ComposeRepository.",
    recentMessages: [
      {
        id: 2,
        role: "assistant" as const,
        content: "First answer",
        createdAt: "2026-06-18T00:00:02.000Z",
      },
      {
        id: 3,
        role: "user" as const,
        content: "Where is retry implemented?",
        createdAt: "2026-06-18T00:00:03.000Z",
      },
    ],
    conversationSummary: "Need to verify retry ownership.",
    sourceStatus: {
      total: 1,
      byKind: { file: 1 },
      byConversionStatus: { converted: 1 },
      convertedSourceIds: [21],
      failedSourceIds: [],
      generatedResearchSourceIds: [],
    },
    generatedResearch: [],
    attachedSources: [],
    pendingTasks: [],
    capabilities: [
      {
        name: "code_research" as const,
        executorType: "code_research",
        queue: "research" as const,
        defaultPriority: 70,
        maxRuntimeSeconds: 600,
        maxAttempts: 2,
        requiresWorkspace: true,
        requiresContextVersion: true,
        producesGeneratedSource: true,
      },
    ],
  };
}

function contextProjectionFixture() {
  return {
    sessionId: 7,
    version: 4,
    artifactUri: "file:///context/working-context-v4.md",
    structuredArtifactUri: "file:///context/working-context-v4.json",
    summary: {
      objective: "Make retries durable",
      problemStatement: "Retry ownership is unclear",
      recommendedNextActions: ["Verify the repository implementation"],
    },
    facts: [{ id: "fact-1", text: "Retries are persisted" }],
    openQuestions: [{ id: "question-1", text: "Who owns retries?" }],
    conflicts: [],
    decisions: [{ id: "decision-1", text: "Use durable turns" }],
    sourceIds: [21],
    patchIds: [31],
    committedAt: "2026-06-18T00:00:00.000Z",
  };
}

function fakeLlmGateway(decision: unknown): Pick<LlmGateway, "generateObject"> {
  return {
    generateObject: vi.fn().mockResolvedValue(decision),
  };
}
