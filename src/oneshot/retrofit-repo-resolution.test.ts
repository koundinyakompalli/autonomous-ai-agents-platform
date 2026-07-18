import { describe, expect, it, vi } from "vitest";
import type { CodeRepository } from "../orchestrator/database.js";
import type { RepoProfile } from "./repo-router/types.js";
import {
  buildRetrofitSourceCommitLogArgs,
  extractGitHubPullRequestUrlsFromText,
  findRetrofitRepoEvidenceMatches,
  RetrofitSourceEvidenceLookupError,
  resolveRetrofitSourcePullRequestSelection,
  resolveRetrofitRepoMatches,
  type RetrofitRepoEvidenceMatch,
} from "./retrofit-repo-resolution.js";
import { parseRetrofitSourceEvidence } from "./retrofit-source-evidence.js";

function repo(id: number, repo_name: string, repo_url: string): CodeRepository {
  return {
    id,
    repo_name,
    repo_url,
    description: repo_name,
    default_branch: "master",
    created_at: new Date(),
  } as CodeRepository;
}

function profile(repoName: string, aliases: string[]): RepoProfile {
  const section = {
    aliases,
    domains: [],
    packages: [],
    file_path_patterns: [],
    symbols: [],
    endpoints: [],
    tables: [],
  };
  return {
    repoName,
    schema_version: "1",
    profile_version: "test",
    generated_at: "",
    source_repo_commit_sha: "",
    generated: section,
    curated: {
      aliases: [],
      domains: [],
      packages: [],
      file_path_patterns: [],
      symbols: [],
      endpoints: [],
      tables: [],
    },
    merged: section,
    profileText: aliases.join("\n"),
    summary: "",
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("buildRetrofitSourceCommitLogArgs", () => {
  it("builds the retrofit source commit log query oldest-to-newest", () => {
    const args = buildRetrofitSourceCommitLogArgs("/tmp/source.git", {
      sourceJiraKey: "CPDEV-25333",
      sourceBranch: "master",
      targetBranch: "release-4.0",
    });

    expect(args).toEqual([
      "--git-dir=/tmp/source.git",
      "log",
      "--reverse",
      "--format=%H\t%s",
      "--regexp-ignore-case",
      "--extended-regexp",
      "--grep=(^|[^A-Z0-9])CPDEV-25333([^A-Z0-9]|$)",
      "HEAD",
    ]);
  });
});

describe("extractGitHubPullRequestUrlsFromText", () => {
  it("extracts and de-duplicates GitHub PR links from Jira text", () => {
    expect(
      extractGitHubPullRequestUrlsFromText(
        [
          "Retrofit source PR: https://github.com/mhk-repos/cp-medhok-monorepo/pull/2575.",
          "Duplicate link https://github.com/mhk-repos/cp-medhok-monorepo/pull/2575",
          "Other source evidence: https://github.com/mhk-repos/cp-batch-monorepo/pull/88?tab=files",
          "Ignore non-PR URL https://github.com/mhk-repos/cp-medhok-monorepo/issues/1",
        ].join("\n"),
      ),
    ).toEqual([
      "https://github.com/mhk-repos/cp-medhok-monorepo/pull/2575",
      "https://github.com/mhk-repos/cp-batch-monorepo/pull/88?tab=files",
    ]);
  });
});

describe("findRetrofitRepoEvidenceMatches", () => {
  const context = {
    sourceJiraKey: "CPDEV-18876",
    sourceBranch: "medhok-monorepo-4.1",
    targetBranch: "medhok-monorepo-3.17",
  };

  it("searches only OneShot-enabled profiled repos for retrofit evidence", async () => {
    const core = repo(
      1,
      "core-app",
      "https://github.com/mhk-repos/cp-medhok-monorepo.git",
    );
    const interop = repo(
      6,
      "interop",
      "https://github.com/mhk-repos/cp-interoperability-monorepo.git",
    );
    const mpWeb = repo(11, "mp-web", "https://github.com/mhk-repos/mp-web.git");
    const inspected: string[] = [];

    const matches = await findRetrofitRepoEvidenceMatches(
      context,
      [core, interop, mpWeb],
      {
        inspectRepo: async (
          candidate,
        ): Promise<RetrofitRepoEvidenceMatch | null> => {
          inspected.push(candidate.repo_name);
          if (candidate.repo_name !== "core-app") {
            return null;
          }
          return {
            repo: candidate,
            sourceHead: {
              branchName: context.sourceBranch,
              headSha: "source-sha",
            },
            targetHead: {
              branchName: context.targetBranch,
              headSha: "target-sha",
            },
            matchingCommits: [
              {
                sha: "abc123",
                subject: "CPDEV-18876 Retrofit to 4.1",
              },
            ],
          };
        },
      },
    );

    expect(inspected).toEqual(["core-app", "interop"]);
    expect(matches).toHaveLength(1);
    expect(matches[0].repo.repo_name).toBe("core-app");
    expect(matches[0].matchingCommits[0].subject).toContain("CPDEV-18876");
  });

  it("runs commit evidence inspection in parallel while preserving candidate order", async () => {
    const core = repo(
      1,
      "core-app",
      "https://github.com/mhk-repos/cp-medhok-monorepo.git",
    );
    const batch = repo(
      2,
      "batch-jobs",
      "https://github.com/mhk-repos/cp-batch-monorepo.git",
    );
    const interop = repo(
      6,
      "interop",
      "https://github.com/mhk-repos/cp-interoperability-monorepo.git",
    );
    let active = 0;
    let maxActive = 0;
    const delaysByRepo = new Map([
      ["core-app", 30],
      ["batch-jobs", 10],
      ["interop", 5],
    ]);

    const matches = await findRetrofitRepoEvidenceMatches(
      context,
      [core, batch, interop],
      {
        inspectRepo: async (
          candidate,
        ): Promise<RetrofitRepoEvidenceMatch | null> => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await delay(delaysByRepo.get(candidate.repo_name) ?? 1);
          active -= 1;
          if (candidate.repo_name === "batch-jobs") {
            return null;
          }
          return {
            repo: candidate,
            sourceHead: {
              branchName: context.sourceBranch,
              headSha: `${candidate.repo_name}-source`,
            },
            targetHead: {
              branchName: context.targetBranch,
              headSha: `${candidate.repo_name}-target`,
            },
            matchingCommits: [
              {
                sha: `${candidate.repo_name}-sha`,
                subject: "CPDEV-18876 Retrofit evidence",
              },
            ],
          };
        },
      },
    );

    expect(maxActive).toBeGreaterThan(1);
    expect(matches.map((match) => match.repo.repo_name)).toEqual([
      "core-app",
      "interop",
    ]);
  });

  it("propagates retryable source lookup failures instead of hiding them as no evidence", async () => {
    const core = repo(
      1,
      "core-app",
      "https://github.com/mhk-repos/cp-medhok-monorepo.git",
    );

    await expect(
      findRetrofitRepoEvidenceMatches(context, [core], {
        inspectRepo: async () => {
          throw new RetrofitSourceEvidenceLookupError(
            "retrofit_source_lookup_failed: GitHub token expired.",
          );
        },
      }),
    ).rejects.toThrow(/retrofit_source_lookup_failed/);
  });
});

describe("resolveRetrofitSourcePullRequestSelection", () => {
  it("uses source-run PR evidence before grep fallback and keeps every PR commit in order", async () => {
    const core = repo(
      1,
      "core-app",
      "https://github.com/mhk-repos/cp-medhok-monorepo.git",
    );
    const fetchPullRequestCommits = vi.fn().mockResolvedValue([
      {
        sha: "6bde29c6be70fd9b09762dbcb4d945dda8af92e7",
        message: "[PFOS] CPDEV-25448: capture auth number",
      },
      {
        sha: "e173af2905116ac87f0343256968aed6418015f8",
        message: "Fix PR review formatting for claim auth number",
      },
    ]);
    const fetchPullRequestFiles = vi.fn().mockResolvedValue([
      "MedicalMgmt/src/main/java/com/medhok/mm/service/ClaimService.java",
      "MedicalMgmt/src/test/java/com/medhok/mm/service/ClaimServiceAuthorizationNumberTest.java",
      "Framework/src/main/java/com/medhok/framework/domain/MemberMedicalClaimDetail.java",
      "Framework/src/main/resources/com/medhok/framework/domain/MemberMedicalClaimDetail.hbm.xml",
    ]);

    const selection = await resolveRetrofitSourcePullRequestSelection(
      core,
      {
        sourceJiraKey: "CPDEV-25448",
        sourceBranch: "master",
        targetBranch: "medhok-monorepo-4.1",
      },
      [
        {
          prUrl:
            "https://github.com/mhk-repos/cp-medhok-monorepo/pull/2575",
          method: "source_run_pr",
        },
      ],
      {
        fetchPullRequestCommits,
        fetchPullRequestFiles,
      },
    );

    expect(selection).toMatchObject({
      sourcePrUrl:
        "https://github.com/mhk-repos/cp-medhok-monorepo/pull/2575",
      method: "source_run_pr",
      complete: true,
    });
    expect(selection?.commits).toEqual([
      expect.objectContaining({
        sha: "6bde29c6be70fd9b09762dbcb4d945dda8af92e7",
        files: expect.arrayContaining([
          "MedicalMgmt/src/main/java/com/medhok/mm/service/ClaimService.java",
        ]),
      }),
      expect.objectContaining({
        sha: "e173af2905116ac87f0343256968aed6418015f8",
        subject: "Fix PR review formatting for claim auth number",
        files: expect.arrayContaining([
          "Framework/src/main/resources/com/medhok/framework/domain/MemberMedicalClaimDetail.hbm.xml",
        ]),
      }),
    ]);
    expect(fetchPullRequestCommits).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "mhk-repos",
        repo: "cp-medhok-monorepo",
        pullNumber: 2575,
      }),
    );
    expect(fetchPullRequestFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "mhk-repos",
        repo: "cp-medhok-monorepo",
        pullNumber: 2575,
      }),
    );
  });

  it("wraps source PR lookup failures as retryable source PR lookup failures", async () => {
    const core = repo(
      1,
      "core-app",
      "https://github.com/mhk-repos/cp-medhok-monorepo.git",
    );

    await expect(
      resolveRetrofitSourcePullRequestSelection(
        core,
        {
          sourceJiraKey: "CPDEV-25448",
          sourceBranch: "master",
          targetBranch: "medhok-monorepo-4.1",
        },
        [
          {
            prUrl:
              "https://github.com/mhk-repos/cp-medhok-monorepo/pull/2575",
            method: "source_run_pr",
          },
        ],
        {
          fetchPullRequestCommits: vi
            .fn()
            .mockRejectedValue(new Error("GitHub API timed out")),
          fetchPullRequestFiles: vi.fn(),
        },
      ),
    ).rejects.toMatchObject({
      name: "RetrofitSourceEvidenceLookupError",
      failureKind: "source_pr_lookup_failed",
    });
  });
});

describe("resolveRetrofitRepoMatches", () => {
  it("does not qualify a profile-selected repo without exact source evidence", async () => {
    const batch = repo(
      2,
      "batch-jobs",
      "https://github.com/mhk-repos/cp-batch-monorepo.git",
    );
    const core = repo(
      1,
      "core-app",
      "https://github.com/mhk-repos/cp-medhok-monorepo.git",
    );
    const inspectRepo = vi.fn().mockResolvedValue(null);

    const resolution = await resolveRetrofitRepoMatches(
      {
        sourceJiraKey: "CPDEV-1234",
        sourceBranch: "batch-monorepo-master",
        targetBranch: "batch-monorepo-3.18",
      },
      [batch, core],
      {
        inspectRepo,
        profiles: new Map([
          ["batch-jobs", profile("batch-jobs", ["batch-monorepo"])],
          ["core-app", profile("core-app", ["medhok-monorepo"])],
        ]),
      },
    );

    expect(resolution.resolutionSource).toBe("none");
    expect(resolution.matches).toEqual([]);
    expect(resolution.profileMatches).toEqual([
      expect.objectContaining({
        repo: expect.objectContaining({ repo_name: "batch-jobs" }),
        branchRole: "source",
        branchToken: "batch-monorepo",
        tokenKind: "stable_prefix",
        matchedAlias: "batch-monorepo",
        aliasSource: "profile",
        score: 100,
      }),
      expect.objectContaining({
        repo: expect.objectContaining({ repo_name: "batch-jobs" }),
        branchRole: "target",
        branchToken: "batch-monorepo",
        tokenKind: "stable_prefix",
      }),
    ]);
    expect(resolution.warnings).toContain(
      "source_evidence_missing: Retrofit CPDEV-1234 matched repository profile batch-jobs, but no exact source commit evidence was found on batch-monorepo-master in any OneShot-enabled repository.",
    );
    expect(inspectRepo).toHaveBeenNthCalledWith(1, batch, {
      sourceJiraKey: "CPDEV-1234",
      sourceBranch: "batch-monorepo-master",
      targetBranch: "batch-monorepo-3.18",
    });
    expect(inspectRepo).toHaveBeenNthCalledWith(2, core, {
      sourceJiraKey: "CPDEV-1234",
      sourceBranch: "batch-monorepo-master",
      targetBranch: "batch-monorepo-3.18",
    });
  });

  it("still inspects deterministic source evidence when a branch profile alias selects one repo", async () => {
    const core = repo(
      1,
      "core-app",
      "https://github.com/mhk-repos/cp-medhok-monorepo.git",
    );
    const interop = repo(
      6,
      "interop",
      "https://github.com/mhk-repos/cp-interoperability-monorepo.git",
    );
    const inspectRepo = vi.fn(async (candidate, context) => {
      if (candidate.repo_name !== "core-app") return null;
      return {
        repo: candidate,
        sourceHead: { branchName: context.sourceBranch, headSha: "source" },
        targetHead: { branchName: context.targetBranch, headSha: "target" },
        matchingCommits: [
          {
            sha: "abc123",
            subject: "CPDEV-18876 source fix",
            files: [
              "MedicalMgmt/src/main/java/com/medhok/mm/client/admin/UIComponentDetailView.java",
            ],
            patchSummary:
              '+fieldValues.setSortField("uiComponentValuesDisplay");',
          },
        ],
      };
    });

    const resolution = await resolveRetrofitRepoMatches(
      {
        sourceJiraKey: "CPDEV-18876",
        sourceBranch: "medhok-monorepo-4.1",
        targetBranch: "medhok-monorepo-3.17",
      },
      [core, interop],
      {
        inspectRepo,
        profiles: new Map([
          ["core-app", profile("core-app", ["medhok-monorepo"])],
          ["interop", profile("interop", ["interoperability"])],
        ]),
      },
    );

    expect(resolution.resolutionSource).toBe("commit_evidence");
    expect(resolution.matches[0].repo.repo_name).toBe("core-app");
    expect(resolution.matches[0].matchingCommits[0]).toMatchObject({
      sha: "abc123",
      files: [
        "MedicalMgmt/src/main/java/com/medhok/mm/client/admin/UIComponentDetailView.java",
      ],
      patchSummary:
        '+fieldValues.setSortField("uiComponentValuesDisplay");',
    });
    expect(resolution.matches[0].profileMatch).toMatchObject({
      branchRole: "source",
      tokenKind: "stable_prefix",
      aliasSource: "profile",
      score: 100,
    });
    expect(inspectRepo).toHaveBeenNthCalledWith(1, core, {
      sourceJiraKey: "CPDEV-18876",
      sourceBranch: "medhok-monorepo-4.1",
      targetBranch: "medhok-monorepo-3.17",
    });
    expect(inspectRepo).toHaveBeenNthCalledWith(2, interop, {
      sourceJiraKey: "CPDEV-18876",
      sourceBranch: "medhok-monorepo-4.1",
      targetBranch: "medhok-monorepo-3.17",
    });
  });

  it("still returns additional source-evidence repos after one profile alias wins", async () => {
    const core = repo(
      1,
      "core-app",
      "https://github.com/mhk-repos/cp-medhok-monorepo.git",
    );
    const batch = repo(
      2,
      "batch-jobs",
      "https://github.com/mhk-repos/cp-batch-monorepo.git",
    );

    const resolution = await resolveRetrofitRepoMatches(
      {
        sourceJiraKey: "CPDEV-24856",
        sourceBranch: "medhok-monorepo-master",
        targetBranch: "medhok-monorepo-4.2",
      },
      [core, batch],
      {
        profiles: new Map([
          ["core-app", profile("core-app", ["medhok-monorepo"])],
          ["batch-jobs", profile("batch-jobs", ["batch-monorepo"])],
        ]),
        inspectRepo: async (candidate, context) => ({
          repo: candidate,
          sourceHead: { branchName: context.sourceBranch, headSha: "source" },
          targetHead: { branchName: context.targetBranch, headSha: "target" },
          matchingCommits: [
            {
              sha: candidate.repo_name === "core-app" ? "core24856" : "batch24856",
              subject: `CPDEV-24856 ${candidate.repo_name} source fix`,
              files: [`${candidate.repo_name}/source-file.ts`],
              patchSummary: `diff --git a/${candidate.repo_name}/source-file.ts b/${candidate.repo_name}/source-file.ts`,
            },
          ],
        }),
      },
    );

    expect(resolution.resolutionSource).toBe("commit_evidence");
    expect(resolution.commitEvidenceInspectedRepoNames).toEqual([
      "core-app",
      "batch-jobs",
    ]);
    expect(resolution.matches.map((match) => match.repo.repo_name)).toEqual([
      "core-app",
      "batch-jobs",
    ]);
    expect(
      resolution.matches.find((match) => match.repo.repo_name === "core-app")
        ?.profileMatch?.repo.repo_name,
    ).toBe("core-app");
    expect(
      resolution.matches.find((match) => match.repo.repo_name === "batch-jobs")
        ?.profileMatch,
    ).toBeUndefined();
  });

  it("keeps CPDEV-24856 retrofit evidence anchored to UIComponentDetailView", async () => {
    const core = repo(
      1,
      "core-app",
      "https://github.com/mhk-repos/cp-medhok-monorepo.git",
    );
    const evidenceFile =
      "MedicalMgmt/src/main/java/com/medhok/mm/client/admin/UIComponentDetailView.java";

    const resolution = await resolveRetrofitRepoMatches(
      {
        sourceJiraKey: "CPDEV-24856",
        sourceBranch: "master",
        targetBranch: "medhok-monorepo-4.2",
      },
      [core],
      {
        profiles: new Map([
          ["core-app", profile("core-app", ["medhok-monorepo"])],
        ]),
        inspectRepo: async (candidate, context) => ({
          repo: candidate,
          sourceHead: { branchName: context.sourceBranch, headSha: "source" },
          targetHead: { branchName: context.targetBranch, headSha: "target" },
          matchingCommits: [
            {
              sha: "de882e2",
              subject: "CPDEV-24856 Tufts | Fix Dropdown Sort Issue",
              files: [evidenceFile],
              patchSummary:
                '+fieldValues.setSortField("uiComponentValuesDisplay");',
            },
          ],
        }),
      },
    );

    expect(resolution.matches[0].sourceEvidence).toMatchObject({
      sourceJiraKey: "CPDEV-24856",
      touchedFiles: [evidenceFile],
      selectedCommits: [
        expect.objectContaining({
          sha: "de882e2",
          files: [evidenceFile],
        }),
      ],
    });
    expect(resolution.matches[0].sourceEvidence?.touchedFiles).not.toContain(
      "MedicalMgmt/src/main/java/com/medhok/mm/service/UIComponentBusinessService.java",
    );
  });

  it("preserves complete source PR commit-selection metadata in generated evidence", async () => {
    const core = repo(
      1,
      "core-app",
      "https://github.com/mhk-repos/cp-medhok-monorepo.git",
    );

    const resolution = await resolveRetrofitRepoMatches(
      {
        sourceJiraKey: "CPDEV-24856",
        sourceBranch: "master",
        targetBranch: "medhok-monorepo-4.2",
      },
      [core],
      {
        profiles: new Map([
          ["core-app", profile("core-app", ["medhok-monorepo"])],
        ]),
        inspectRepo: async (candidate, context) => ({
          repo: candidate,
          sourceHead: { branchName: context.sourceBranch, headSha: "source" },
          targetHead: { branchName: context.targetBranch, headSha: "target" },
          sourcePrUrl:
            "https://github.com/mhk-repos/cp-medhok-monorepo/pull/82",
          commitSelectionMethod: "source_pr",
          sourceCommitSelectionComplete: true,
          matchingCommits: [
            {
              sha: "1111111",
              subject: "CPDEV-24856 first source commit",
              files: ["src/First.java"],
            },
            {
              sha: "2222222",
              subject: "Second source commit without Jira key",
              files: ["src/Second.java"],
            },
          ],
        }),
      },
    );

    expect(resolution.matches[0].sourceEvidence).toMatchObject({
      sourcePrUrl:
        "https://github.com/mhk-repos/cp-medhok-monorepo/pull/82",
      commitSelectionMethod: "source_pr",
      sourceCommitSelectionComplete: true,
      selectedCommits: [
        expect.objectContaining({ sha: "1111111" }),
        expect.objectContaining({ sha: "2222222" }),
      ],
    });
    expect(resolution.matches[0].sourceEvidence?.evidenceSummary).toContain(
      "explicit source pull request",
    );
  });

  it("keeps generated source evidence inside the planner metadata schema caps", async () => {
    const core = repo(
      1,
      "core-app",
      "https://github.com/mhk-repos/cp-medhok-monorepo.git",
    );
    const touchedFiles = Array.from(
      { length: 95 },
      (_, index) => `MedicalMgmt/src/main/java/com/medhok/mm/F${String(index + 1).padStart(2, "0")}.java`,
    );
    const matchingCommits = Array.from({ length: 25 }, (_, index) => ({
      sha: `abcdef${String(index).padStart(2, "0")}`,
      subject: `CPDEV-24856 source commit ${index + 1}`,
      files: touchedFiles,
      patchSummary: `diff --git a/file${index}.java b/file${index}.java\n+change ${index}`,
    }));

    const resolution = await resolveRetrofitRepoMatches(
      {
        sourceJiraKey: "CPDEV-24856",
        sourceBranch: "master",
        targetBranch: "medhok-monorepo-4.2",
      },
      [core],
      {
        profiles: new Map([
          ["core-app", profile("core-app", ["medhok-monorepo"])],
        ]),
        inspectRepo: async (candidate, context) => ({
          repo: candidate,
          sourceHead: { branchName: context.sourceBranch, headSha: "source" },
          targetHead: { branchName: context.targetBranch, headSha: "target" },
          matchingCommits,
        }),
      },
    );

    const evidence = resolution.matches[0].sourceEvidence;
    const parsed = parseRetrofitSourceEvidence(evidence);

    expect(parsed).not.toBeNull();
    expect(parsed?.selectedCommits).toHaveLength(20);
    expect(parsed?.touchedFiles).toHaveLength(80);
    expect(parsed?.evidenceSummary.length).toBeLessThanOrEqual(4_000);
  });

  it("returns every repo with matching source evidence for multi-repo retrofit fan-out", async () => {
    const batch = repo(
      2,
      "batch-jobs",
      "https://github.com/mhk-repos/cp-batch-monorepo.git",
    );
    const core = repo(
      1,
      "core-app",
      "https://github.com/mhk-repos/cp-medhok-monorepo.git",
    );

    const resolution = await resolveRetrofitRepoMatches(
      {
        sourceJiraKey: "CPDEV-1234",
        sourceBranch: "shared-monorepo-master",
        targetBranch: "shared-monorepo-3.18",
      },
      [batch, core],
      {
        profiles: new Map([
          ["batch-jobs", profile("batch-jobs", ["shared-monorepo"])],
          ["core-app", profile("core-app", ["shared-monorepo"])],
        ]),
        inspectRepo: async (candidate, context) => ({
          repo: candidate,
          sourceHead: { branchName: context.sourceBranch, headSha: "source" },
          targetHead: { branchName: context.targetBranch, headSha: "target" },
          matchingCommits: [
            {
              sha: candidate.repo_name === "batch-jobs" ? "batch123" : "core1234",
              subject: `CPDEV-1234 ${candidate.repo_name} source fix`,
              files: [`${candidate.repo_name}/source-file.ts`],
              patchSummary: `diff --git a/${candidate.repo_name}/source-file.ts b/${candidate.repo_name}/source-file.ts`,
            },
          ],
        }),
      },
    );

    expect(resolution.resolutionSource).toBe("commit_evidence");
    expect(resolution.matches.map((match) => match.repo.repo_name)).toEqual([
      "batch-jobs",
      "core-app",
    ]);
    expect(resolution.matches.flatMap((match) => match.matchingCommits)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sha: "batch123" }),
        expect.objectContaining({ sha: "core1234" }),
      ]),
    );
  });

  it("orders profile candidates by score before falling back to repo name", async () => {
    const batch = repo(
      2,
      "batch-jobs",
      "https://github.com/mhk-repos/cp-batch-monorepo.git",
    );
    const core = repo(
      1,
      "core-app",
      "https://github.com/mhk-repos/cp-medhok-monorepo.git",
    );
    const inspected: string[] = [];

    const resolution = await resolveRetrofitRepoMatches(
      {
        sourceJiraKey: "CPDEV-1234",
        sourceBranch: "source-monorepo-master",
        targetBranch: "target-monorepo-3.18",
      },
      [batch, core],
      {
        profiles: new Map([
          ["batch-jobs", profile("batch-jobs", ["target-monorepo"])],
          ["core-app", profile("core-app", ["source-monorepo"])],
        ]),
        inspectRepo: async (candidate) => {
          inspected.push(candidate.repo_name);
          return null;
        },
      },
    );

    expect(resolution.profileMatches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          repo: expect.objectContaining({ repo_name: "core-app" }),
          branchRole: "source",
          tokenKind: "stable_prefix",
          score: 100,
        }),
        expect.objectContaining({
          repo: expect.objectContaining({ repo_name: "batch-jobs" }),
          branchRole: "target",
          tokenKind: "stable_prefix",
          score: 80,
        }),
      ]),
    );
    expect(inspected).toEqual(["core-app", "batch-jobs"]);
    expect(resolution.commitEvidenceInspectedRepoNames).toEqual([
      "core-app",
      "batch-jobs",
    ]);
  });

  it("falls back to commit evidence when branch profile aliases are ambiguous", async () => {
    const batch = repo(
      2,
      "batch-jobs",
      "https://github.com/mhk-repos/cp-batch-monorepo.git",
    );
    const core = repo(
      1,
      "core-app",
      "https://github.com/mhk-repos/cp-medhok-monorepo.git",
    );
    const inspected: string[] = [];

    const resolution = await resolveRetrofitRepoMatches(
      {
        sourceJiraKey: "CPDEV-1234",
        sourceBranch: "shared-monorepo-master",
        targetBranch: "shared-monorepo-3.18",
      },
      [batch, core],
      {
        profiles: new Map([
          ["batch-jobs", profile("batch-jobs", ["shared-monorepo"])],
          ["core-app", profile("core-app", ["shared-monorepo"])],
        ]),
        inspectRepo: async (candidate, context) => {
          inspected.push(candidate.repo_name);
          if (candidate.repo_name !== "batch-jobs") return null;
          return {
            repo: candidate,
            sourceHead: { branchName: context.sourceBranch, headSha: "source" },
            targetHead: { branchName: context.targetBranch, headSha: "target" },
            matchingCommits: [
              { sha: "abc123", subject: "CPDEV-1234 retrofit source" },
            ],
          };
        },
      },
    );

    expect(resolution.profileMatches.map((match) => match.repo.repo_name)).toEqual(
      expect.arrayContaining(["batch-jobs", "core-app"]),
    );
    expect(resolution.profileAmbiguityWarnings).toEqual([
      "profile_ambiguity: Retrofit source branch token shared-monorepo matched multiple repository profiles: batch-jobs, core-app.",
      "profile_ambiguity: Retrofit target branch token shared-monorepo matched multiple repository profiles: batch-jobs, core-app.",
    ]);
    expect(inspected).toEqual(["batch-jobs", "core-app"]);
    expect(resolution.resolutionSource).toBe("commit_evidence");
    expect(resolution.matches).toHaveLength(1);
    expect(resolution.matches[0].repo.repo_name).toBe("batch-jobs");
  });

  it("falls back to commit evidence when no profile alias matches", async () => {
    const core = repo(
      1,
      "core-app",
      "https://github.com/mhk-repos/cp-medhok-monorepo.git",
    );
    const interop = repo(
      6,
      "interop",
      "https://github.com/mhk-repos/cp-interoperability-monorepo.git",
    );
    const inspected: string[] = [];
    let active = 0;
    let maxActive = 0;

    const resolution = await resolveRetrofitRepoMatches(
      {
        sourceJiraKey: "CPDEV-18876",
        sourceBranch: "unknown-monorepo-4.1",
        targetBranch: "unknown-monorepo-3.17",
      },
      [core, interop],
      {
        profiles: new Map([
          ["core-app", profile("core-app", ["medhok-monorepo"])],
          ["interop", profile("interop", ["interoperability"])],
        ]),
        inspectRepo: async (candidate, context) => {
          inspected.push(candidate.repo_name);
          active += 1;
          maxActive = Math.max(maxActive, active);
          await delay(candidate.repo_name === "core-app" ? 15 : 5);
          active -= 1;
          if (candidate.repo_name !== "core-app") return null;
          return {
            repo: candidate,
            sourceHead: { branchName: context.sourceBranch, headSha: "source" },
            targetHead: { branchName: context.targetBranch, headSha: "target" },
            matchingCommits: [
              { sha: "abc123", subject: "CPDEV-18876 retrofit source" },
            ],
          };
        },
      },
    );

    expect(resolution.profileMatches).toEqual([]);
    expect(resolution.warnings).toEqual([
      "no_profile_candidates: No retrofit branch profile aliases matched unknown-monorepo-4.1 or unknown-monorepo-3.17; commit evidence inspected enabled repositories.",
    ]);
    expect(resolution.commitEvidenceInspectedRepoNames).toEqual([
      "core-app",
      "interop",
    ]);
    expect((resolution as any).inspectedRepoNames).toBeUndefined();
    expect(maxActive).toBeGreaterThan(1);
    expect(inspected).toEqual(["core-app", "interop"]);
    expect(resolution.resolutionSource).toBe("commit_evidence");
    expect(resolution.matches[0].repo.repo_name).toBe("core-app");
  });

  it("inspects all enabled profile candidates and finds lower-ranked source evidence", async () => {
    const repos = [
      repo(2, "batch-jobs", "https://github.com/mhk-repos/cp-batch-monorepo.git"),
      repo(3, "client-services", "https://github.com/mhk-repos/cp-client-services-monorepo.git"),
      repo(1, "core-app", "https://github.com/mhk-repos/cp-medhok-monorepo.git"),
      repo(6, "interop", "https://github.com/mhk-repos/cp-interoperability-monorepo.git"),
      repo(7, "data-visor", "https://github.com/mhk-repos/cp-datalake-pipeline.git"),
      repo(11, "mp-web", "https://github.com/mhk-repos/mp-web.git"),
    ];
    const inspected: string[] = [];

    const resolution = await resolveRetrofitRepoMatches(
      {
        sourceJiraKey: "CPDEV-1234",
        sourceBranch: "shared-monorepo-master",
        targetBranch: "shared-monorepo-3.18",
      },
      repos,
      {
        profiles: new Map(
          repos.map((candidate) => [
            candidate.repo_name.toLowerCase(),
            profile(candidate.repo_name, ["shared-monorepo"]),
          ]),
        ),
        inspectRepo: async (candidate, context) => {
          inspected.push(candidate.repo_name);
          if (candidate.repo_name === "data-visor") {
            return {
              repo: candidate,
              sourceHead: {
                branchName: context.sourceBranch,
                headSha: "source-sha",
              },
              targetHead: {
                branchName: context.targetBranch,
                headSha: "target-sha",
              },
              matchingCommits: [
                {
                  sha: "lower-ranked-sha",
                  subject: "CPDEV-1234 lower-ranked repo source evidence",
                },
              ],
            };
          }
          return null;
        },
      },
    );

    expect(inspected).toEqual([
      "batch-jobs",
      "client-services",
      "core-app",
      "data-visor",
      "interop",
    ]);
    expect(resolution.commitEvidenceInspectedRepoNames).toEqual(inspected);
    expect(resolution.resolutionSource).toBe("commit_evidence");
    expect(resolution.matches).toHaveLength(1);
    expect(resolution.matches[0].repo.repo_name).toBe("data-visor");
    expect(resolution.matches[0].matchingCommits[0].sha).toBe(
      "lower-ranked-sha",
    );
  });
});
