import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvidenceManifest } from "./evidence.js";
import { SpecFactoryTaskWorkspaceManager } from "./evidence-workspace.js";
import type { SpecFactoryRepoContextManifest } from "./repo-context.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "spec-factory-task-"));
  tempRoots.push(tempRoot);
  return tempRoot;
}

function evidenceManifest(): EvidenceManifest {
  return {
    sourceJiraKey: "CPDEV-22410",
    sourceSummary: "Enrollment sync rules",
    sourceStatus: "In Progress",
    sourceLabels: ["louise-estimated"],
    descriptionMarkdown: "Client A needs enrollment sync validation.",
    loeHours: 38,
    loeSource: "attachment:LOE-CPDEV-22410.md",
    comments: [
      {
        id: "1001",
        author: "Louise",
        created: "2026-05-27T12:00:00.000Z",
        bodyMarkdown: "Development needs current-code validation.",
      },
    ],
    artifacts: [
      {
        kind: "loe_estimate",
        filename: "LOE-CPDEV-22410.md",
        content: "Total LOE: 38 hours",
      },
      {
        kind: "code_changes",
        filename: "../Development-Plan-CPDEV-22410.md",
        content: "Inspect service/EnrollmentSyncValidator.java",
      },
    ],
    repoReferences: {
      matchedRepos: [
        {
          repoId: 7,
          repoName: "core-app",
          repoUrl: "https://github.com/org/core-app.git",
          defaultBranch: "master",
          evidenceRefs: ["attachment:Development-Plan-CPDEV-22410.md"],
        },
      ],
      unresolvedHints: [],
      warnings: [],
    },
    warnings: [],
  };
}

function repoContext(repoPath: string): SpecFactoryRepoContextManifest {
  return {
    sourceJiraKey: "CPDEV-22410",
    repos: [
      {
        repoName: "core-app",
        branch: "master",
        headSha: "abc123",
        workspacePath: repoPath,
        repoId: "spec-factory-source-12-core-app",
        inspectedPaths: ["service/EnrollmentSyncValidator.java"],
        evidenceRefs: ["attachment:Development-Plan-CPDEV-22410.md"],
        summaries: [],
        warnings: [],
      },
    ],
    unresolvedHints: [],
    warnings: [],
  };
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((tempRoot) =>
      fs.rm(tempRoot, { recursive: true, force: true }),
    ),
  );
});

describe("SpecFactoryTaskWorkspaceManager", () => {
  it("writes ticket evidence, attachment files, repo context, and repo links into one task workspace", async () => {
    const tempRoot = await makeTempRoot();
    const repoPath = path.join(tempRoot, "repo-workspaces", "core-app");
    await fs.mkdir(repoPath, { recursive: true });
    const registerRepoFromPath = vi.fn(() => "spec-factory-task-12");
    const manager = new SpecFactoryTaskWorkspaceManager(
      path.join(tempRoot, "tasks"),
      registerRepoFromPath,
    );

    const workspace = await manager.prepare({
      sourceId: 12,
      evidenceManifest: evidenceManifest(),
      repoContextManifest: repoContext(repoPath),
    });

    expect(workspace.repoId).toBe("spec-factory-task-12");
    expect(registerRepoFromPath).toHaveBeenCalledWith(
      workspace.workspacePath,
      "spec-factory-task-12",
    );
    await expect(
      fs.readFile(path.join(workspace.evidenceDir, "ticket.md"), "utf8"),
    ).resolves.toContain("CPDEV-22410: Enrollment sync rules");
    await expect(
      fs.readFile(path.join(workspace.evidenceDir, "attachments.md"), "utf8"),
    ).resolves.toContain("Total LOE: 38 hours");
    await expect(
      fs.readFile(path.join(workspace.evidenceDir, "attachment-index.md"), "utf8"),
    ).resolves.toContain("evidence/attachments/LOE-CPDEV-22410.md");
    await expect(
      fs.readFile(path.join(workspace.evidenceDir, "evidence-summary.json"), "utf8"),
    ).resolves.toContain("\"contentChars\"");
    await expect(
      fs.readFile(
        path.join(workspace.attachmentsDir, "Development-Plan-CPDEV-22410.md"),
        "utf8",
      ),
    ).resolves.toContain("EnrollmentSyncValidator");
    await expect(
      fs.readFile(path.join(workspace.workspacePath, "repo-context.json"), "utf8"),
    ).resolves.toContain("service/EnrollmentSyncValidator.java");
    await expect(
      fs.readFile(
        path.join(workspace.workspacePath, "repo-context-summary.json"),
        "utf8",
      ),
    ).resolves.toContain("\"summaryPaths\"");
    await expect(
      fs.readFile(path.join(workspace.workspacePath, "task-workspace.json"), "utf8"),
    ).resolves.toContain("spec-factory-task-12");

    const repoLink = path.join(workspace.reposDir, "core-app");
    const linkStat = await fs.lstat(repoLink);
    expect(linkStat.isSymbolicLink()).toBe(true);
    await expect(fs.readlink(repoLink)).resolves.toBe(repoPath);
    expect(workspace.repoLinks).toEqual([
      {
        repoName: "core-app",
        workspacePath: repoPath,
        linkPath: repoLink,
        linked: true,
      },
    ]);
  });

  it("writes compact index files so agents do not need to read oversized audit manifests", async () => {
    const tempRoot = await makeTempRoot();
    const registerRepoFromPath = vi.fn(() => "spec-factory-task-13");
    const manager = new SpecFactoryTaskWorkspaceManager(
      path.join(tempRoot, "tasks"),
      registerRepoFromPath,
    );
    const manifest = evidenceManifest();
    manifest.artifacts = [
      {
        kind: "code_changes",
        filename: "Development-Plan-CPDEV-22410.md",
        content: `${"Inspect EnrollmentSyncValidator. ".repeat(30_000)}`,
        extractionStatus: "extracted",
      },
    ];
    manifest.repoClassifierContext = {
      profiledRepos: [
        {
          repoId: 7,
          repoName: "core-app",
          summary: "Core app profile. ".repeat(20_000),
          aliases: ["core"],
          domains: ["enrollment"],
          packages: ["com.medhok.core"],
        },
      ],
    };

    const workspace = await manager.prepare({
      sourceId: 13,
      evidenceManifest: manifest,
      repoContextManifest: {
        sourceJiraKey: "CPDEV-22410",
        repos: [
          {
            repoName: "core-app",
            branch: "master",
            headSha: "abc123",
            workspacePath: "/tmp/core-app",
            repoId: "spec-factory-source-13-core-app",
            inspectedPaths: ["service/EnrollmentSyncValidator.java"],
            evidenceRefs: ["attachment:Development-Plan-CPDEV-22410.md"],
            summaries: [
              {
                path: "service/EnrollmentSyncValidator.java",
                snippet: "class EnrollmentSyncValidator {}".repeat(50_000),
              },
            ],
            warnings: [],
          },
        ],
        unresolvedHints: [],
        warnings: [],
      },
    });

    const attachmentIndex = await fs.readFile(
      path.join(workspace.evidenceDir, "attachment-index.md"),
      "utf8",
    );
    const evidenceSummary = await fs.readFile(
      path.join(workspace.evidenceDir, "evidence-summary.json"),
      "utf8",
    );
    const classifierIndex = await fs.readFile(
      path.join(workspace.evidenceDir, "repo-classifier-index.md"),
      "utf8",
    );
    const repoContextSummary = await fs.readFile(
      path.join(workspace.workspacePath, "repo-context-summary.json"),
      "utf8",
    );

    expect(attachmentIndex.length).toBeLessThan(4_000);
    expect(evidenceSummary.length).toBeLessThan(4_000);
    expect(classifierIndex.length).toBeLessThan(4_000);
    expect(repoContextSummary.length).toBeLessThan(4_000);
    expect(classifierIndex).toContain(
      "evidence/repo-classifier-profiles/7-core-app.md",
    );
    expect(repoContextSummary).not.toContain("class EnrollmentSyncValidator");
    expect(evidenceSummary).not.toContain("Inspect EnrollmentSyncValidator. ".repeat(10));
  });
});
