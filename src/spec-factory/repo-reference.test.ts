import { describe, expect, it } from "vitest";
import type { CodeRepository } from "../orchestrator/database.js";
import type { EvidenceManifest } from "./evidence.js";
import { buildRepoReferenceManifest } from "./repo-reference.js";

function repositories(): CodeRepository[] {
  return [
    {
      id: 7,
      repo_name: "core-app",
      repo_url: "https://github.com/mhk-repos/core-app.git",
      description: "Core app",
      default_branch: "master",
      created_at: new Date("2026-05-27T12:00:00.000Z"),
    },
    {
      id: 8,
      repo_name: "config-service",
      repo_url: "https://github.com/mhk-repos/config-service.git",
      description: "Config service",
      default_branch: "main",
      created_at: new Date("2026-05-27T12:00:00.000Z"),
    },
  ];
}

function evidence(overrides: Partial<EvidenceManifest> = {}): EvidenceManifest {
  return {
    sourceJiraKey: "CPDEV-22410",
    sourceSummary: "Enrollment sync rules",
    sourceStatus: "In Progress",
    sourceLabels: ["louise-estimated"],
    descriptionMarkdown: "repository: core-app",
    loeHours: 44,
    loeSource: "attachment:LOE-CPDEV-22410.md",
    comments: [
      {
        id: "20010",
        author: "Louise",
        created: "2026-05-27T12:00:00.000Z",
        bodyMarkdown: "config-service/settings/client.yml should be updated.",
      },
    ],
    artifacts: [
      {
        kind: "code_changes",
        filename: "Development-Plan-CPDEV-22410.md",
        content: "Change core-app/src/Validator.java.",
      },
      {
        kind: "other",
        filename: "notes.txt",
        content: "repo: ignored-other-repo",
      },
    ],
    warnings: [],
    ...overrides,
  };
}

describe("buildRepoReferenceManifest", () => {
  it("matches explicit repo hints and path prefixes against code_repositories", () => {
    const manifest = buildRepoReferenceManifest(evidence(), repositories());

    expect(manifest.matchedRepos).toEqual([
      {
        repoId: 8,
        repoName: "config-service",
        repoUrl: "https://github.com/mhk-repos/config-service.git",
        defaultBranch: "main",
        evidenceRefs: ["comment:0"],
      },
      {
        repoId: 7,
        repoName: "core-app",
        repoUrl: "https://github.com/mhk-repos/core-app.git",
        defaultBranch: "master",
        evidenceRefs: [
          "description",
          "attachment:Development-Plan-CPDEV-22410.md",
        ],
      },
    ]);
    expect(manifest.warnings).toEqual([]);
  });

  it("surfaces unresolved explicit repo hints", () => {
    const manifest = buildRepoReferenceManifest(
      evidence({
        descriptionMarkdown: "repo: missing-repo",
        comments: [],
        artifacts: [],
      }),
      repositories(),
    );

    expect(manifest.matchedRepos).toEqual([]);
    expect(manifest.unresolvedHints).toEqual(["missing-repo"]);
    expect(manifest.warnings).toEqual(
      expect.arrayContaining([
        "Repository hint could not be resolved against code_repositories: missing-repo",
        "No repository references matched code_repositories.",
      ]),
    );
  });

  it("reuses OneShot domain rules to classify repo from Louise code terminology", () => {
    const manifest = buildRepoReferenceManifest(
      evidence({
        descriptionMarkdown: "",
        comments: [],
        artifacts: [
          {
            kind: "code_changes",
            filename: "Development-Plan-CPDEV-22410.md",
            content:
              "DerContextMenu and der_request_types enable post-approval case edit for Rx cases.",
          },
        ],
      }),
      repositories(),
    );

    expect(manifest.matchedRepos).toEqual([
      expect.objectContaining({
        repoId: 7,
        repoName: "core-app",
      }),
    ]);
    expect(manifest.matchedRepos[0]?.evidenceRefs).toEqual(
      expect.arrayContaining([
        expect.stringContaining("domain-rule:Matched domain phrase"),
      ]),
    );
  });
});
