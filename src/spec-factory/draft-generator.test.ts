import { describe, expect, it, vi } from "vitest";
import { DraftGenerator } from "./draft-generator.js";
import type { SpecFactoryTaskWorkspace } from "./evidence-workspace.js";
import type { EvidenceManifest } from "./evidence.js";
import type { SpecFactoryRepoContextManifest } from "./repo-context.js";
import type { SpecFactoryDraftBundle } from "./types.js";

function evidenceManifest(): EvidenceManifest {
  return {
    sourceJiraKey: "CPDEV-22410",
    sourceSummary: "Enrollment sync rules",
    sourceStatus: "In Progress",
    sourceLabels: ["louise-estimated"],
    descriptionMarkdown: "Client A needs enrollment sync validation.",
    loeHours: 38,
    comments: [],
    artifacts: [
      {
        kind: "loe_estimate",
        filename: "loe-estimate.md",
        content: "Total LOE: 38 hours",
      },
    ],
    warnings: [],
  };
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

function taskWorkspace(): SpecFactoryTaskWorkspace {
  return {
    repoId: "spec-factory-task-12",
    workspacePath: "/mnt/efs/specter-repo/spec-factory/tasks/12",
    evidenceDir: "/mnt/efs/specter-repo/spec-factory/tasks/12/evidence",
    attachmentsDir:
      "/mnt/efs/specter-repo/spec-factory/tasks/12/evidence/attachments",
    reposDir: "/mnt/efs/specter-repo/spec-factory/tasks/12/repos",
    repoLinks: [
      {
        repoName: "core-app",
        workspacePath:
          "/mnt/efs/specter-repo/spec-factory/workspaces/12/core-app",
        linkPath: "/mnt/efs/specter-repo/spec-factory/tasks/12/repos/core-app",
        linked: true,
      },
    ],
  };
}

describe("DraftGenerator", () => {
  it("returns a validated bundle and rendered markdown from structured output", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      success: true,
      output: "",
      structuredOutput: validBundle(),
      metrics: {
        durationMs: 100,
        toolCalls: 0,
        tokensUsed: { input: 1000, output: 500 },
        modelUsed: "test-model",
      },
    });
    const generator = new DraftGenerator(runAgent, "test-model");

    const result = await generator.generate({
      sourceId: 12,
      sourceJiraKey: "CPDEV-22410",
      repoIds: ["spec-factory-source-12-core-app"],
      evidenceManifest: evidenceManifest(),
    });

    expect(result.bundle.sourceJiraKey).toBe("CPDEV-22410");
    expect(result.bundle.loeHours).toBe(38);
    expect(result.bundle.childTickets[0].repoName).toBe("core-app");
    expect(result.renderedMarkdown).toContain("Repo: core-app");
    expect(result.validation.valid).toBe(true);
    expect(result.modelMetadata).toMatchObject({
      provider: "bedrock",
      model: "test-model",
      metrics: expect.objectContaining({ durationMs: 100 }),
    });
    expect(runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        repoIds: ["spec-factory-source-12-core-app"],
        agentType: "custom",
        permissionLevel: "read_only",
        allowWrite: false,
        bedrockConfig: { region: "us-east-2", model: "test-model" },
        systemAppend: expect.stringContaining("evidence-first workflow"),
      }),
    );
    expect(runAgent.mock.calls[0][0].taskPrompt).toContain("CPDEV-22410");
    expect(runAgent.mock.calls[0][0].taskPrompt).toContain(
      "Repo deep-dive is disabled for this run.",
    );
    expect(runAgent.mock.calls[0][0].taskPrompt).toContain(
      "Write child tickets against the repo references in the evidence manifest",
    );
    expect(runAgent.mock.calls[0][0].taskPrompt).not.toContain(
      "Repository context JSON:",
    );
    expect(runAgent.mock.calls[0][0].taskPrompt).not.toContain(
      "Total LOE: 38 hours",
    );
    expect(runAgent.mock.calls[0][0].taskPrompt.length).toBeLessThan(8_000);
    const outputSchema = runAgent.mock.calls[0][0].outputSchema;
    expect(outputSchema.type).toBe("object");
    expect(outputSchema.properties).toMatchObject({
      sourceJiraKey: expect.objectContaining({ type: "string" }),
      epic: expect.objectContaining({
        type: "object",
        properties: expect.any(Object),
        required: expect.arrayContaining(["summary", "description"]),
      }),
      childTickets: expect.objectContaining({
        type: "array",
        items: expect.objectContaining({
          type: "object",
          properties: expect.objectContaining({
            repoName: expect.objectContaining({ type: "string" }),
            technicalDetails: expect.objectContaining({
              type: "object",
              properties: expect.objectContaining({
                repo: expect.objectContaining({ type: "string" }),
                implementationNotes: expect.objectContaining({ type: "array" }),
              }),
              required: expect.arrayContaining(["repo", "implementationNotes"]),
            }),
          }),
          required: expect.arrayContaining([
            "repoName",
            "summary",
            "overview",
            "acceptanceCriteria",
            "technicalDetails",
          ]),
        }),
      }),
    });
    expect(outputSchema.required).toEqual(
      expect.arrayContaining(["sourceJiraKey", "epic", "childTickets"]),
    );
  });

  it("allows longer code deep-dive draft runs by default", async () => {
    const originalTimeout = process.env.SPEC_FACTORY_DRAFT_TIMEOUT_MS;
    delete process.env.SPEC_FACTORY_DRAFT_TIMEOUT_MS;
    const runAgent = vi.fn().mockResolvedValue({
      success: true,
      output: "",
      structuredOutput: validBundle(),
      metrics: {
        durationMs: 100,
        toolCalls: 0,
        modelUsed: "test-model",
      },
    });
    const generator = new DraftGenerator(runAgent, "test-model");

    try {
      await generator.generate({
        sourceId: 12,
        sourceJiraKey: "CPDEV-22410",
        repoIds: ["spec-factory-source-12-core-app"],
        evidenceManifest: evidenceManifest(),
      });
    } finally {
      if (originalTimeout === undefined) {
        delete process.env.SPEC_FACTORY_DRAFT_TIMEOUT_MS;
      } else {
        process.env.SPEC_FACTORY_DRAFT_TIMEOUT_MS = originalTimeout;
      }
    }

    expect(runAgent.mock.calls[0][0].timeoutMs).toBe(20 * 60 * 1000);
  });

  it("rejects invalid draft output", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      success: true,
      output: "",
      structuredOutput: {
        ...validBundle(),
        childTickets: [],
      },
      metrics: {
        durationMs: 100,
        toolCalls: 0,
      },
    });
    const generator = new DraftGenerator(runAgent, "test-model");

    await expect(
      generator.generate({
        sourceId: 12,
        sourceJiraKey: "CPDEV-22410",
        repoIds: ["spec-factory-source-12-core-app"],
        evidenceManifest: evidenceManifest(),
      }),
    ).rejects.toThrow("Draft bundle failed validation");
  });

  it("rejects missing registered repo workspaces before calling runAgent", async () => {
    const runAgent = vi.fn();
    const generator = new DraftGenerator(runAgent, "test-model");

    await expect(
      generator.generate({
        sourceId: 12,
        sourceJiraKey: "CPDEV-22410",
        repoIds: ["", "   "],
        evidenceManifest: evidenceManifest(),
      }),
    ).rejects.toThrow(
      "Spec Factory draft generation requires at least one registered repo workspace",
    );

    expect(runAgent).not.toHaveBeenCalled();
  });

  it("rejects repo context repoIds missing from registered repoIds before calling runAgent", async () => {
    const runAgent = vi.fn();
    const generator = new DraftGenerator(runAgent, "test-model");

    await expect(
      generator.generate({
        sourceId: 12,
        sourceJiraKey: "CPDEV-22410",
        repoIds: ["spec-factory-source-12-core-app"],
        evidenceManifest: evidenceManifest(),
        repoContextManifest: {
          sourceJiraKey: "CPDEV-22410",
          repos: [
            {
              repoName: "core-app",
              branch: "master",
              headSha: "abc123",
              workspacePath: "/workspaces/12/core-app",
              repoId: "spec-factory-source-12-other-repo",
              inspectedPaths: [],
              evidenceRefs: [],
              summaries: [],
              warnings: [],
            },
          ],
          unresolvedHints: [],
          warnings: [],
        },
      }),
    ).rejects.toThrow(
      "Spec Factory repo context repoIds must be included in GenerateDraftInput.repoIds",
    );

    expect(runAgent).not.toHaveBeenCalled();
  });

  it("allows extra registered repoIds and forwards them to runAgent", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      success: true,
      output: "",
      structuredOutput: validBundle(),
      metrics: {
        durationMs: 100,
        toolCalls: 0,
        modelUsed: "test-model",
      },
    });
    const generator = new DraftGenerator(runAgent, "test-model");

    await generator.generate({
      sourceId: 12,
      sourceJiraKey: "CPDEV-22410",
      repoIds: [
        "spec-factory-source-12-core-app",
        "spec-factory-source-12-configs",
      ],
      evidenceManifest: evidenceManifest(),
      repoContextManifest: {
        sourceJiraKey: "CPDEV-22410",
        repos: [
          {
            repoName: "core-app",
            branch: "master",
            headSha: "abc123",
            workspacePath: "/workspaces/12/core-app",
            repoId: "spec-factory-source-12-core-app",
            inspectedPaths: [],
            evidenceRefs: [],
            summaries: [],
            warnings: [],
          },
        ],
        unresolvedHints: [],
        warnings: [],
      },
    });

    expect(runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        repoIds: [
          "spec-factory-source-12-core-app",
          "spec-factory-source-12-configs",
        ],
      }),
    );
  });

  it("includes repo context summary and selected-branch/current-code rules in the prompt", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      success: true,
      output: "",
      structuredOutput: validBundle(),
      metrics: {
        durationMs: 100,
        toolCalls: 0,
        modelUsed: "test-model",
      },
    });
    const repoContextManifest: SpecFactoryRepoContextManifest = {
      sourceJiraKey: "CPDEV-22410",
      repos: [
        {
          repoName: "core-app",
          branch: "main",
          headSha: "abc123",
          workspacePath: "/workspaces/12/core-app",
          repoId: "spec-factory-source-12-core-app",
          inspectedPaths: ["service/EnrollmentSyncValidator.java"],
          evidenceRefs: ["attachment:code-changes.md"],
          summaries: [
            {
              path: "service/EnrollmentSyncValidator.java",
              snippet: "class EnrollmentSyncValidator {}",
            },
          ],
          warnings: ["Missing hinted path on master: service/Stale.java"],
        },
      ],
      unresolvedHints: [],
      warnings: [],
    };
    const generator = new DraftGenerator(runAgent, "test-model");

    await generator.generate({
      sourceId: 12,
      sourceJiraKey: "CPDEV-22410",
      repoIds: ["spec-factory-source-12-core-app"],
      evidenceManifest: evidenceManifest(),
      repoContextManifest,
    });

    const prompt = runAgent.mock.calls[0][0].taskPrompt;
    expect(prompt).toContain("Repository context summary");
    expect(prompt).toContain("repoId=spec-factory-source-12-core-app");
    expect(prompt).toContain("branch=main");
    expect(prompt).not.toContain("class EnrollmentSyncValidator {}");
    expect(prompt).toContain(
      "Write child tickets against the selected repository grounding branch from repo-context-summary.json; Spec Factory prefers master and falls back to main only when master is missing.",
    );
    expect(prompt).toContain("Use Louise attachments as evidence and hints.");
    expect(prompt).toContain(
      "Verify and improve requirements from current code/config context on the selected grounding branch.",
    );
    expect(prompt).toContain(
      "Prefer observed current repo context over stale attachment claims, and surface conflicts as warnings.",
    );
  });

  it("instructs the model to enumerate an evidence map, cite source filenames, and calibrate reading depth", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      success: true,
      output: "",
      structuredOutput: validBundle(),
      metrics: {
        durationMs: 100,
        toolCalls: 0,
        modelUsed: "test-model",
      },
    });
    const generator = new DraftGenerator(runAgent, "test-model");

    await generator.generate({
      sourceId: 12,
      sourceJiraKey: "CPDEV-22410",
      repoIds: ["spec-factory-source-12-core-app"],
      evidenceManifest: evidenceManifest(),
    });

    const prompt = runAgent.mock.calls[0][0].taskPrompt as string;
    expect(prompt).toContain(
      "Build an explicit evidence map for the files you considered",
    );
    expect(prompt).toContain(
      "Cite the source filename for every factual claim",
    );
    expect(prompt).toContain(
      "Calibrate reading depth to document type: read authoritative summaries end-to-end",
    );
  });

  it("treats Compose handoff bundle artifacts as first-class draft evidence", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      success: true,
      output: "",
      structuredOutput: validBundle({
        sourceJiraKey: "COMPOSE-7",
      }),
      metrics: {
        durationMs: 100,
        toolCalls: 0,
        modelUsed: "test-model",
      },
    });
    const generator = new DraftGenerator(runAgent, "test-model");

    await generator.generate({
      sourceId: 12,
      sourceJiraKey: "COMPOSE-7",
      repoIds: ["spec-factory-source-12-core-app"],
      evidenceManifest: {
        ...evidenceManifest(),
        sourceJiraKey: "COMPOSE-7",
        artifacts: [
          {
            kind: "raw_requirement",
            filename: "handoff-v1.md",
            content:
              "Highly detailed Compose handoff content that should remain file evidence.",
            isPriority: true,
            extractionStatus: "stored",
          },
          {
            kind: "other",
            filename: "handoff-v1.json",
            content: "{\"schemaVersion\":1,\"sessionId\":7}",
            extractionStatus: "stored",
          },
        ],
      },
    });

    const prompt = runAgent.mock.calls[0][0].taskPrompt as string;
    expect(prompt).toContain("Compose handoff bundle detected");
    expect(prompt).toContain("handoff-v1.md");
    expect(prompt).toContain("handoff-v1.json");
    expect(prompt).toContain(
      "Treat handoff-v1.md as the authoritative Compose session synthesis",
    );
    expect(prompt).not.toContain(
      "Highly detailed Compose handoff content that should remain file evidence.",
    );
  });

  it("makes the task workspace the first repo and instructs evidence-first code review", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      success: true,
      output: "",
      structuredOutput: validBundle(),
      metrics: {
        durationMs: 100,
        toolCalls: 0,
        modelUsed: "test-model",
      },
    });
    const workspace = taskWorkspace();
    const generator = new DraftGenerator(runAgent, "test-model");

    await generator.generate({
      sourceId: 12,
      sourceJiraKey: "CPDEV-22410",
      repoIds: ["spec-factory-task-12", "spec-factory-source-12-core-app"],
      evidenceManifest: evidenceManifest(),
      taskWorkspace: workspace,
      repoContextManifest: {
        sourceJiraKey: "CPDEV-22410",
        repos: [
          {
            repoName: "core-app",
            branch: "master",
            headSha: "abc123",
            workspacePath:
              "/mnt/efs/specter-repo/spec-factory/workspaces/12/core-app",
            repoId: "spec-factory-source-12-core-app",
            inspectedPaths: ["service/EnrollmentSyncValidator.java"],
            evidenceRefs: ["attachment:loe-estimate.md"],
            summaries: [],
            warnings: [],
          },
        ],
        unresolvedHints: [],
        warnings: [],
      },
    });

    expect(runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        repoIds: ["spec-factory-task-12", "spec-factory-source-12-core-app"],
      }),
    );
    const prompt = runAgent.mock.calls[0][0].taskPrompt;
    expect(prompt).toContain("Task workspace:");
    expect(prompt).toContain("Registered repo id: spec-factory-task-12");
    expect(prompt).toContain(
      "Mandatory order: read compact evidence/context first, inspect only targeted code second, then write the draft bundle.",
    );
    expect(prompt).toContain(
      "Start by reading evidence/evidence-summary.json, evidence/attachment-index.md, evidence/repo-references.json, evidence/repo-classifier-index.md, repo-context-summary.json, and evidence/attachments/context.md when present. Read other attachments selectively by title/preview when needed.",
    );
    expect(prompt).toContain("Do not open full audit manifests directly");
    expect(prompt).toContain(
      "After evidence review, search and read current code/config under repos/* and the registered repository workspaces.",
    );
  });

  it("uses story-driven wording and lists stories when composeStories is present", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      success: true,
      output: "",
      structuredOutput: validBundle(),
      metrics: {
        durationMs: 1,
        toolCalls: 0,
        tokensUsed: { input: 1, output: 1 },
        modelUsed: "test-model",
      },
    });
    const generator = new DraftGenerator(runAgent, "test-model");
    await generator.generate({
      sourceId: 12,
      sourceJiraKey: "COMPOSE-5",
      repoIds: ["spec-factory-source-12-core-app"],
      evidenceManifest: {
        ...evidenceManifest(),
        composeStories: [
          {
            id: "story-1",
            title: "Token plumbing",
            summary: "Send token",
            sequence: 1,
          },
          {
            id: "story-2",
            title: "Draft fidelity",
            summary: "One child per story",
            sequence: 2,
          },
        ],
      },
    });
    const prompt = runAgent.mock.calls[0][0].taskPrompt as string;
    expect(prompt).toContain("exactly one child ticket per story");
    expect(prompt).not.toContain(
      "Return exactly one Epic and one child Story/Task per repository involved.",
    );
    expect(prompt).toContain("Token plumbing");
    expect(prompt).toContain("Draft fidelity");
  });

  it("uses modular child-story wording when no composeStories are provided", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      success: true,
      output: "",
      structuredOutput: validBundle(),
      metrics: {
        durationMs: 1,
        toolCalls: 0,
        tokensUsed: { input: 1, output: 1 },
        modelUsed: "test-model",
      },
    });
    const generator = new DraftGenerator(runAgent, "test-model");
    await generator.generate({
      sourceId: 12,
      sourceJiraKey: "CPDEV-22410",
      repoIds: ["spec-factory-source-12-core-app"],
      evidenceManifest: evidenceManifest(),
    });
    const prompt = runAgent.mock.calls[0][0].taskPrompt as string;
    expect(prompt).toContain(
      "Return exactly one Epic and as many modular child Story/Task tickets as the implementation needs; multiple child tickets may target the same repo when the work has separable slices.",
    );
    expect(prompt).not.toContain(
      "Return exactly one Epic and one child Story/Task per repository involved.",
    );
  });
});
