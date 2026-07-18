import { describe, expect, it, vi } from "vitest";
import { SpecFactoryQualifier } from "./qualifier.js";
import type { EvidenceManifest } from "./evidence.js";
import type { SpecFactoryTaskWorkspace } from "./evidence-workspace.js";

function evidenceManifest(): EvidenceManifest {
  return {
    sourceJiraKey: "CPDEV-22410",
    sourceSummary: "Retarus fax delivery",
    sourceStatus: "In Progress",
    sourceLabels: ["louise-estimated"],
    descriptionMarkdown: "Client needs Retarus fax delivery implementation.",
    loeHours: 18,
    loeSource: "attachment:LOE-CPDEV-22410.md",
    comments: [],
    artifacts: [
      {
        kind: "config_changes",
        filename: "Configuration-Plan-CPDEV-22410.md",
        content: "Configuration notes: no code changes in this config section.",
        extractionStatus: "extracted",
      },
      {
        kind: "code_changes",
        filename: "Development-Plan-CPDEV-22410.md",
        content:
          "Implementation details: update RetarusFaxService.java and add integration tests.",
        extractionStatus: "extracted",
      },
    ],
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
    repoClassifierContext: {
      profiledRepos: [
        {
          repoId: 7,
          repoName: "core-app",
          summary: "Core application services and SmartGWT workflows.",
          aliases: ["core"],
          domains: ["fax delivery", "care management"],
          packages: ["com.medhok.core"],
        },
      ],
    },
    warnings: [],
  };
}

function taskWorkspace(): SpecFactoryTaskWorkspace {
  return {
    repoId: "spec-factory-task-12",
    workspacePath: "/mnt/efs/specter-repo/spec-factory/tasks/12",
    evidenceDir: "/mnt/efs/specter-repo/spec-factory/tasks/12/evidence",
    attachmentsDir: "/mnt/efs/specter-repo/spec-factory/tasks/12/evidence/attachments",
    reposDir: "/mnt/efs/specter-repo/spec-factory/tasks/12/repos",
    repoLinks: [],
  };
}

describe("SpecFactoryQualifier", () => {
  it("runs an evidence-only qualification agent against the task workspace", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      success: true,
      output: "",
      structuredOutput: {
        qualified: true,
        nextAction: "generate_epic",
        reasons: [],
        confidence: "high",
        summary: "Development evidence exists for core-app.",
        evidenceRefs: ["attachment:Development-Plan-CPDEV-22410.md"],
        repoHints: [
          {
            repoName: "core-app",
            evidenceRefs: ["attachment:Development-Plan-CPDEV-22410.md"],
            confidence: "high",
          },
        ],
        warnings: ["Configuration-only portions should stay out of code stories."],
      },
      metrics: {
        durationMs: 100,
        toolCalls: 2,
        modelUsed: "test-model",
      },
    });
    const qualifier = new SpecFactoryQualifier(runAgent, "test-model");

    const result = await qualifier.qualify({
      sourceId: 12,
      sourceJiraKey: "CPDEV-22410",
      evidenceManifest: evidenceManifest(),
      taskWorkspace: taskWorkspace(),
    });

    expect(result).toMatchObject({
      qualified: true,
      reasons: [],
      confidence: "high",
      summary: "Development evidence exists for core-app.",
      modelMetadata: {
        provider: "bedrock",
        model: "test-model",
      },
    });
    expect(runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        repoIds: ["spec-factory-task-12"],
        agentType: "custom",
        sdkStage: "qualification",
        permissionLevel: "read_only",
        allowWrite: false,
        bedrockConfig: { region: "us-east-2", model: "test-model" },
        systemAppend: expect.stringContaining("evidence-only"),
      }),
    );
    const prompt = runAgent.mock.calls[0][0].taskPrompt;
    expect(prompt).toContain("Use evidence only; do not inspect repository code");
    expect(prompt).toContain("Read evidence/ticket.md first.");
    expect(prompt).toContain("Do not treat this prompt as the source evidence body.");
    expect(prompt).toContain("Task workspace:");
    expect(prompt).toContain("evidence/repo-classifier-index.md");
    expect(prompt).toContain("evidence/attachment-index.md");
    expect(prompt).toContain("Do not open full audit manifests directly");
    expect(prompt).toContain("Repo classifier profile names: core-app(id=7)");
    expect(prompt).toContain("Do not mark a request config-only");
    expect(prompt).toContain("Development-Plan-CPDEV-22410.md");
    expect(prompt).not.toContain("RetarusFaxService.java");
    expect(prompt).not.toContain(
      "Configuration notes: no code changes in this config section.",
    );
    expect(prompt.length).toBeLessThan(8_000);
  });

  it("normalizes not-qualified decisions with empty reasons to needs_information", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      success: true,
      output: "",
      structuredOutput: {
        qualified: false,
        nextAction: "not_qualified",
        reasons: [],
        confidence: "low",
        summary: "The request does not have enough implementation detail.",
        evidenceRefs: [],
        repoHints: [],
        warnings: [],
      },
      metrics: {
        durationMs: 100,
        toolCalls: 1,
        modelUsed: "test-model",
      },
    });
    const qualifier = new SpecFactoryQualifier(runAgent, "test-model");

    await expect(
      qualifier.qualify({
        sourceId: 12,
        sourceJiraKey: "CPDEV-22410",
        evidenceManifest: evidenceManifest(),
        taskWorkspace: taskWorkspace(),
      }),
    ).resolves.toMatchObject({
      qualified: false,
      reasons: ["needs_information"],
    });
  });
});
