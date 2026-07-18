import { describe, expect, it, vi } from "vitest";
import { DraftGenerator } from "./draft-generator.js";
import type { EvidenceManifest } from "./evidence.js";
import {
  MAX_SNIPPET_CHARS,
  SpecFactoryRepoContextCollector,
  type SpecFactoryRepoContextManifest,
} from "./repo-context.js";
import type { SpecFactoryRepoWorkspaceManager } from "./repo-workspace.js";
import type { SpecFactoryDraftBundle } from "./types.js";

function reader(readSnippet = vi.fn(async () => "")) {
  return {
    realPath: vi.fn(async (filePath: string) => filePath),
    readSnippet,
  };
}

function evidenceManifest(overrides: Partial<EvidenceManifest> = {}): EvidenceManifest {
  return {
    sourceJiraKey: "CPDEV-22410",
    sourceSummary: "Enrollment sync rules",
    sourceStatus: "In Progress",
    sourceLabels: ["louise-estimated"],
    descriptionMarkdown:
      "Louise notes repo: core-app and service/EnrollmentSyncValidator.java should be checked.",
    loeHours: 38,
    comments: [
      {
        author: "Louise",
        bodyMarkdown: "repository core-app has config/client-a/enrollment.yml changes.",
        created: "2026-05-26T12:00:00.000Z",
      },
    ],
    artifacts: [
      {
        kind: "code_changes",
        filename: "code-changes.md",
        content: "Update core-app/service/EnrollmentSyncValidator.java and service/Rules.java",
      },
      {
        kind: "config_changes",
        filename: "config-changes.md",
        content: "Config path config/client-a/enrollment.yml needs a threshold flag.",
      },
    ],
    warnings: [],
    ...overrides,
  };
}

function validBundle(): SpecFactoryDraftBundle {
  return {
    sourceJiraKey: "CPDEV-22410",
    loeHours: 38,
    epic: {
      summary: "Automate enrollment sync validation",
      description: "Implement current-code-grounded validation.",
      businessContext: ["Louise estimated the work."],
      acceptanceCriteria: ["Child ticket reflects current master."],
      assumptions: [],
      dependencies: [],
    },
    childTickets: [
      {
        repoName: "core-app",
        summary: "[core-app] Add validation",
        overview: "Use master branch context.",
        acceptanceCriteria: ["Validation is added.", "Regression tests cover it."],
        technicalDetails: {
          repo: "core-app",
          branch: "master",
          targetFiles: ["service/EnrollmentSyncValidator.java"],
          implementationNotes: ["Use current service entry point."],
        },
        outOfScope: [],
        testingNotes: ["Run service tests."],
        sourceEvidenceRefs: ["repo-context:core-app:service/EnrollmentSyncValidator.java"],
      },
    ],
    evidenceSummary: ["Repo context was inspected."],
    warnings: [],
  };
}

describe("SpecFactoryRepoContextCollector", () => {
  it("extracts repo and file hints, prepares master workspaces, reads bounded snippets, and warns for missing files", async () => {
    const prepareMasterWorkspace = vi.fn(async () => ({
      repoName: "core-app",
      branch: "master" as const,
      headSha: "abc123",
      repoRoot: "/cache/core-app",
      workspacePath: "/workspaces/12/core-app",
      repoId: "spec-factory-source-12-core-app",
    }));
    const readSnippet = vi.fn(async (path: string) => {
      if (path.endsWith("service/EnrollmentSyncValidator.java")) {
        return "class EnrollmentSyncValidator { void validate() {} }";
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    const contextReader = reader(readSnippet);
    const collector = new SpecFactoryRepoContextCollector({
      lookupRepositories: vi.fn(async () => [
        {
          id: 1,
          repo_name: "core-app",
          repo_url: "https://github.com/org/core.git",
          description: "Core App",
          default_branch: "master",
          created_at: new Date(),
        },
      ]),
      workspaceManager: {
        prepareMasterWorkspace,
      } as unknown as SpecFactoryRepoWorkspaceManager,
      reader: contextReader,
    });

    const manifest = await collector.collect({
      sourceId: 12,
      evidenceManifest: evidenceManifest(),
    });

    expect(prepareMasterWorkspace).toHaveBeenCalledWith({
      sourceId: 12,
      repo: expect.objectContaining({ repo_name: "core-app" }),
    });
    expect(manifest.repos).toHaveLength(1);
    expect(manifest.repos[0]).toMatchObject({
      repoName: "core-app",
      branch: "master",
      headSha: "abc123",
      workspacePath: "/workspaces/12/core-app",
      repoId: "spec-factory-source-12-core-app",
      inspectedPaths: ["service/EnrollmentSyncValidator.java"],
      evidenceRefs: expect.arrayContaining([
        "description",
        "comment:0",
        "attachment:code-changes.md",
        "attachment:config-changes.md",
      ]),
      summaries: [
        {
          path: "service/EnrollmentSyncValidator.java",
          snippet: "class EnrollmentSyncValidator { void validate() {} }",
        },
      ],
    });
    expect(manifest.repos[0].warnings).toEqual(
      expect.arrayContaining([
        "Missing hinted path on master: config/client-a/enrollment.yml",
        "Missing hinted path on master: service/Rules.java",
      ]),
    );
    expect(readSnippet).toHaveBeenCalledWith(
      "/workspaces/12/core-app/service/EnrollmentSyncValidator.java",
      MAX_SNIPPET_CHARS,
    );
    expect(contextReader.realPath).toHaveBeenCalledWith("/workspaces/12/core-app");
    expect(contextReader.realPath).toHaveBeenCalledWith(
      "/workspaces/12/core-app/service/EnrollmentSyncValidator.java",
    );
  });

  it("reports unresolved repository hints without preparing a workspace", async () => {
    const prepareMasterWorkspace = vi.fn();
    const collector = new SpecFactoryRepoContextCollector({
      lookupRepositories: vi.fn(async () => []),
      workspaceManager: {
        prepareMasterWorkspace,
      } as unknown as SpecFactoryRepoWorkspaceManager,
      reader: reader(),
    });

    const manifest = await collector.collect({
      sourceId: 12,
      evidenceManifest: evidenceManifest({
        descriptionMarkdown: "repo: missing-repo",
        comments: [],
        artifacts: [],
      }),
    });

    expect(manifest.unresolvedHints).toEqual(["missing-repo"]);
    expect(manifest.warnings).toEqual(
      expect.arrayContaining(["Repository hint could not be resolved: missing-repo"]),
    );
    expect(prepareMasterWorkspace).not.toHaveBeenCalled();
  });

  it("prepares repo-reference workspaces and applies LOE path hints without explicit repo text", async () => {
    const prepareMasterWorkspace = vi.fn(async () => ({
      repoName: "core-app",
      branch: "master" as const,
      headSha: "abc123",
      repoRoot: "/cache/core-app",
      workspacePath: "/workspaces/12/core-app",
      repoId: "spec-factory-source-12-core-app",
    }));
    const contextReader = reader(
      vi.fn(async () => "class EnrollmentSyncValidator { void validate() {} }"),
    );
    const collector = new SpecFactoryRepoContextCollector({
      lookupRepositories: vi.fn(async () => [
        {
          id: 1,
          repo_name: "core-app",
          repo_url: "https://github.com/org/core.git",
          description: "Core App",
          default_branch: "master",
          created_at: new Date(),
        },
      ]),
      workspaceManager: {
        prepareMasterWorkspace,
      } as unknown as SpecFactoryRepoWorkspaceManager,
      reader: contextReader,
    });

    const manifest = await collector.collect({
      sourceId: 12,
      evidenceManifest: evidenceManifest({
        descriptionMarkdown: "",
        comments: [],
        artifacts: [
          {
            kind: "loe_estimate",
            filename: "LOE-CPDEV-22410.md",
            content:
              "Total LOE: 38h. Validate service/EnrollmentSyncValidator.java against current behavior.",
          },
        ],
        repoReferences: {
          matchedRepos: [
            {
              repoId: 1,
              repoName: "core-app",
              repoUrl: "https://github.com/org/core.git",
              defaultBranch: "master",
              evidenceRefs: [
                'domain-rule:Matched domain phrase "member search" for core-app.',
              ],
            },
          ],
          unresolvedHints: [],
          warnings: [],
        },
      }),
    });

    expect(prepareMasterWorkspace).toHaveBeenCalledWith({
      sourceId: 12,
      repo: expect.objectContaining({ repo_name: "core-app" }),
    });
    expect(manifest.repos[0]).toMatchObject({
      repoName: "core-app",
      inspectedPaths: ["service/EnrollmentSyncValidator.java"],
      evidenceRefs: expect.arrayContaining([
        'domain-rule:Matched domain phrase "member search" for core-app.',
        "attachment:LOE-CPDEV-22410.md",
      ]),
      summaries: [
        {
          path: "service/EnrollmentSyncValidator.java",
          snippet: "class EnrollmentSyncValidator { void validate() {} }",
        },
      ],
    });
    expect(contextReader.readSnippet).toHaveBeenCalledWith(
      "/workspaces/12/core-app/service/EnrollmentSyncValidator.java",
      MAX_SNIPPET_CHARS,
    );
  });

  it("uses qualifier repo hints to prepare code workspaces", async () => {
    const prepareMasterWorkspace = vi.fn(async () => ({
      repoName: "core-app",
      branch: "master" as const,
      headSha: "abc123",
      repoRoot: "/cache/core-app",
      workspacePath: "/workspaces/12/core-app",
      repoId: "spec-factory-source-12-core-app",
    }));
    const collector = new SpecFactoryRepoContextCollector({
      lookupRepositories: vi.fn(async () => [
        {
          id: 1,
          repo_name: "core-app",
          repo_url: "https://github.com/org/core.git",
          description: "Core App",
          default_branch: "master",
          created_at: new Date(),
        },
      ]),
      workspaceManager: {
        prepareMasterWorkspace,
      } as unknown as SpecFactoryRepoWorkspaceManager,
      reader: reader(vi.fn(async () => "class RetarusFaxService {}")),
    });

    const manifest = await collector.collect({
      sourceId: 12,
      evidenceManifest: evidenceManifest({
        descriptionMarkdown: "Retarus fax delivery needs implementation.",
        comments: [],
        artifacts: [],
        repoReferences: {
          matchedRepos: [],
          unresolvedHints: [],
          warnings: [],
        },
      }),
      qualification: {
        repoHints: [
          {
            repoName: "core-app",
            evidenceRefs: ["attachment:Development-Plan-CPDEV-22410.md"],
            confidence: "medium",
          },
        ],
      },
    });

    expect(prepareMasterWorkspace).toHaveBeenCalledWith({
      sourceId: 12,
      repo: expect.objectContaining({ repo_name: "core-app" }),
    });
    expect(manifest.repos[0]).toMatchObject({
      repoName: "core-app",
      evidenceRefs: ["qualifier:attachment:Development-Plan-CPDEV-22410.md"],
    });
  });

  it("reports unresolved path-only hints when no repository metadata can resolve them", async () => {
    const prepareMasterWorkspace = vi.fn();
    const collector = new SpecFactoryRepoContextCollector({
      lookupRepositories: vi.fn(async () => []),
      workspaceManager: {
        prepareMasterWorkspace,
      } as unknown as SpecFactoryRepoWorkspaceManager,
      reader: reader(),
    });

    const manifest = await collector.collect({
      sourceId: 12,
      evidenceManifest: evidenceManifest({
        descriptionMarkdown: "",
        comments: [],
        artifacts: [
          {
            kind: "code_changes",
            filename: "code-changes.md",
            content: "Update service/EnrollmentSyncValidator.java for Client A.",
          },
        ],
      }),
    });

    expect(manifest.unresolvedHints).toEqual(["service/EnrollmentSyncValidator.java"]);
    expect(manifest.warnings).toEqual(
      expect.arrayContaining([
        "Path hint could not be tied to a repository on master or main: service/EnrollmentSyncValidator.java",
      ]),
    );
    expect(prepareMasterWorkspace).not.toHaveBeenCalled();
  });

  it("propagates main branch workspace metadata when master falls back to main", async () => {
    const prepareMasterWorkspace = vi.fn(async () => ({
      repoName: "core-app",
      branch: "main" as const,
      headSha: "mainabc",
      repoRoot: "/cache/core-app",
      workspacePath: "/workspaces/12/core-app",
      repoId: "spec-factory-source-12-core-app",
    }));
    const collector = new SpecFactoryRepoContextCollector({
      lookupRepositories: vi.fn(async () => [
        {
          id: 1,
          repo_name: "core-app",
          repo_url: "https://github.com/org/core.git",
          description: "Core App",
          default_branch: "main",
          created_at: new Date(),
        },
      ]),
      workspaceManager: {
        prepareMasterWorkspace,
      } as unknown as SpecFactoryRepoWorkspaceManager,
      reader: reader(vi.fn(async () => "class EnrollmentSyncValidator {}")),
    });

    const manifest = await collector.collect({
      sourceId: 12,
      evidenceManifest: evidenceManifest({
        descriptionMarkdown: "repo: core-app",
        comments: [],
        artifacts: [
          {
            kind: "code_changes",
            filename: "code-changes.md",
            content: "Update core-app/service/EnrollmentSyncValidator.java",
          },
        ],
      }),
    });

    expect(manifest.repos[0]).toMatchObject({
      repoName: "core-app",
      branch: "main",
      headSha: "mainabc",
    });
  });

  it("does not read hinted paths that escape the selected workspace", async () => {
    const prepareMasterWorkspace = vi.fn(async () => ({
      repoName: "core-app",
      branch: "master" as const,
      headSha: "abc123",
      repoRoot: "/cache/core-app",
      workspacePath: "/workspaces/12/core-app",
      repoId: "spec-factory-source-12-core-app",
    }));
    const contextReader = reader(vi.fn());
    const collector = new SpecFactoryRepoContextCollector({
      lookupRepositories: vi.fn(async () => [
        {
          id: 1,
          repo_name: "core-app",
          repo_url: "https://github.com/org/core.git",
          description: "Core App",
          default_branch: "master",
          created_at: new Date(),
        },
      ]),
      workspaceManager: {
        prepareMasterWorkspace,
      } as unknown as SpecFactoryRepoWorkspaceManager,
      reader: contextReader,
    });

    const manifest = await collector.collect({
      sourceId: 12,
      evidenceManifest: evidenceManifest({
        descriptionMarkdown: "",
        comments: [],
        artifacts: [
          {
            kind: "code_changes",
            filename: "code-changes.md",
            content: "Update core-app/../../other/file",
          },
        ],
      }),
    });

    expect(contextReader.readSnippet).not.toHaveBeenCalled();
    expect(manifest.repos[0].warnings).toContain(
      "Unsafe hinted path escapes repository workspace: ../../other/file",
    );
  });

  it("does not read symlinked hinted paths whose real target escapes the selected workspace", async () => {
    const prepareMasterWorkspace = vi.fn(async () => ({
      repoName: "core-app",
      branch: "master" as const,
      headSha: "abc123",
      repoRoot: "/cache/core-app",
      workspacePath: "/workspaces/12/core-app",
      repoId: "spec-factory-source-12-core-app",
    }));
    const contextReader = {
      realPath: vi.fn(async (filePath: string) =>
        filePath.endsWith("/linked-secret")
          ? "/outside/secret"
          : filePath,
      ),
      readSnippet: vi.fn(),
    };
    const collector = new SpecFactoryRepoContextCollector({
      lookupRepositories: vi.fn(async () => [
        {
          id: 1,
          repo_name: "core-app",
          repo_url: "https://github.com/org/core.git",
          description: "Core App",
          default_branch: "master",
          created_at: new Date(),
        },
      ]),
      workspaceManager: {
        prepareMasterWorkspace,
      } as unknown as SpecFactoryRepoWorkspaceManager,
      reader: contextReader,
    });

    const manifest = await collector.collect({
      sourceId: 12,
      evidenceManifest: evidenceManifest({
        descriptionMarkdown: "",
        comments: [],
        artifacts: [
          {
            kind: "code_changes",
            filename: "code-changes.md",
            content: "Update core-app/linked-secret",
          },
        ],
      }),
    });

    expect(contextReader.readSnippet).not.toHaveBeenCalled();
    expect(contextReader.realPath).toHaveBeenCalledWith("/workspaces/12/core-app/linked-secret");
    expect(manifest.repos[0].warnings).toContain(
      "Unsafe hinted path escapes repository workspace: linked-secret",
    );
  });

  it("matches repo path prefixes case-insensitively and ignores domain-looking URL fragments", async () => {
    const prepareMasterWorkspace = vi.fn(async () => ({
      repoName: "core-app",
      branch: "master" as const,
      headSha: "abc123",
      repoRoot: "/cache/core-app",
      workspacePath: "/workspaces/12/core-app",
      repoId: "spec-factory-source-12-core-app",
    }));
    const contextReader = reader(vi.fn(async () => "snippet"));
    const collector = new SpecFactoryRepoContextCollector({
      lookupRepositories: vi.fn(async () => [
        {
          id: 1,
          repo_name: "core-app",
          repo_url: "https://github.com/org/core.git",
          description: "Core App",
          default_branch: "master",
          created_at: new Date(),
        },
      ]),
      workspaceManager: {
        prepareMasterWorkspace,
      } as unknown as SpecFactoryRepoWorkspaceManager,
      reader: contextReader,
    });

    const manifest = await collector.collect({
      sourceId: 12,
      evidenceManifest: evidenceManifest({
        descriptionMarkdown: "",
        comments: [],
        artifacts: [
          {
            kind: "code_changes",
            filename: "code-changes.md",
            content: "Review Core-App/Service/File.java and github.com/org/repo",
          },
        ],
      }),
    });

    expect(manifest.repos[0].inspectedPaths).toEqual(["Service/File.java"]);
    expect(manifest.unresolvedHints).not.toContain("github.com/org/repo");
    expect(contextReader.readSnippet).toHaveBeenCalledWith(
      "/workspaces/12/core-app/Service/File.java",
      MAX_SNIPPET_CHARS,
    );
  });
});

describe("DraftGenerator repo context prompt", () => {
  it("includes repository context and selected-branch precedence rules", async () => {
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
          warnings: [],
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
    expect(prompt).toContain("headSha=abc123");
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
});
