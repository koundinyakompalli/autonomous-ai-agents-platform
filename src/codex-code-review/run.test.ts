import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  assertApplyEligibility,
  buildReviewJobOutputs,
  collectReviewRules,
  createWritableRepoTools,
  getMaxFixToolIterations,
  parseGitPorcelainChangedFiles,
  parseArgs,
  renderReviewMarkdown,
  resolvePrPushTarget,
  type CodexCodeReview,
  type GitHubPullRequestInfo,
} from "./run.js";

const execFileAsync = promisify(execFile);

async function runTestGit(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", root, ...args]);
  return stdout;
}

describe("Codex-Code-Review runner helpers", () => {
  it("parses Jira ticket and PR link inputs", () => {
    const args = parseArgs([
      "--phase",
      "review",
      "--jira-ticket",
      "CPDEV-12345",
      "--pr-link",
      "https://github.com/mhk-repos/cp-medhok-monorepo/pull/42",
      "--post-pr-comment",
      "true",
    ]);

    expect(args.phase).toBe("review");
    expect(args.jiraTicket).toBe("CPDEV-12345");
    expect(args.prLink).toBe(
      "https://github.com/mhk-repos/cp-medhok-monorepo/pull/42",
    );
    expect(args.postPrComment).toBe(true);
  });

  it("parses an artifact-driven apply phase without Jira or PR arguments", () => {
    const args = parseArgs([
      "--phase",
      "apply",
      "--review-dir",
      "review-artifact",
      "--output-dir",
      "fix-artifact",
    ]);

    expect(args.phase).toBe("apply");
    expect(args.jiraTicket).toBe("");
    expect(args.prLink).toBe("");
    expect(args.reviewDir).toBe("review-artifact");
    expect(args.outputDir).toBe("fix-artifact");
  });

  it("uses the dedicated fix budget and falls back to the shared OpenAI budget", () => {
    expect(getMaxFixToolIterations({})).toBe(40);
    expect(getMaxFixToolIterations({ OPENAI_MAX_TOOL_ITERATIONS: "100" })).toBe(
      100,
    );
    expect(
      getMaxFixToolIterations({
        OPENAI_MAX_TOOL_ITERATIONS: "100",
        CODEX_CODE_REVIEW_MAX_FIX_TOOL_ITERATIONS: "75",
      }),
    ).toBe(75);
    expect(() =>
      getMaxFixToolIterations({
        CODEX_CODE_REVIEW_MAX_FIX_TOOL_ITERATIONS: "0",
      }),
    ).toThrow(/must be a positive integer/);
  });

  it("supports targeted replacements and restoring deleted paths from the PR base", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codex-fix-tools-test-"));
    try {
      await runTestGit(root, ["init"]);
      await runTestGit(root, ["config", "user.name", "Codex Test"]);
      await runTestGit(root, ["config", "user.email", "codex@example.com"]);
      await mkdir(path.join(root, "src", "policy-library"), {
        recursive: true,
      });
      await writeFile(
        path.join(root, "src", "policy-library", "index.ts"),
        "export const policyLibrary = true;\n",
        "utf8",
      );
      await writeFile(
        path.join(root, "src", "app.ts"),
        "export const title = 'original';\n",
        "utf8",
      );
      await runTestGit(root, ["add", "-A"]);
      await runTestGit(root, ["commit", "-m", "base"]);
      const baseSha = (await runTestGit(root, ["rev-parse", "HEAD"])).trim();

      await rm(path.join(root, "src", "policy-library"), {
        recursive: true,
        force: true,
      });
      await writeFile(
        path.join(root, "src", "app.ts"),
        "export const title = 'pull request';\n",
        "utf8",
      );
      await runTestGit(root, ["add", "-A"]);
      await runTestGit(root, ["commit", "-m", "pull request"]);

      const repoTools = createWritableRepoTools(root, baseSha);
      await repoTools.execute({
        callId: "restore-call",
        name: "restore_from_base",
        arguments: JSON.stringify({ path: "src/policy-library" }),
      });
      await repoTools.execute({
        callId: "replace-call",
        name: "replace_text",
        arguments: JSON.stringify({
          path: "src/app.ts",
          oldText: "'pull request'",
          newText: "'fixed'",
        }),
      });

      expect(
        await readFile(
          path.join(root, "src", "policy-library", "index.ts"),
          "utf8",
        ),
      ).toBe("export const policyLibrary = true;\n");
      expect(await readFile(path.join(root, "src", "app.ts"), "utf8")).toBe(
        "export const title = 'fixed';\n",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves the PR head repository as the fix push target", () => {
    const pr: GitHubPullRequestInfo = {
      owner: "mhk-repos",
      repo: "cp-medhok-monorepo",
      pullNumber: 42,
      htmlUrl: "https://github.com/mhk-repos/cp-medhok-monorepo/pull/42",
      title: "Fix issue",
      body: "",
      state: "open",
      draft: false,
      baseRef: "master",
      baseSha: "abc",
      headRef: "feature",
      headSha: "def",
      headOwner: "dev-fork",
      headRepo: "cp-medhok-monorepo",
      headRepoFullName: "dev-fork/cp-medhok-monorepo",
      author: "dev",
    };

    const target = resolvePrPushTarget(pr, "ghp_token");

    expect(target.repository).toBe("dev-fork/cp-medhok-monorepo");
    expect(target.ref).toBe("feature");
    expect(target.displayUrl).toBe(
      "https://github.com/dev-fork/cp-medhok-monorepo.git",
    );
  });

  it("parses git porcelain paths without corrupting unstaged status lines", () => {
    expect(
      parseGitPorcelainChangedFiles(
        [
          " M src/codex-code-review/run.ts",
          "A  src/new-file.ts",
          "R  src/old-name.ts -> src/new-name.ts",
          "?? docs/new-note.md",
        ].join("\n"),
      ),
    ).toEqual([
      "src/codex-code-review/run.ts",
      "src/new-file.ts",
      "src/new-name.ts",
      "docs/new-note.md",
    ]);
  });

  it("only exposes NEEDS_CHANGES reviews as apply candidates", () => {
    const pr: GitHubPullRequestInfo = {
      owner: "mhk-repos",
      repo: "cp-medhok-monorepo",
      pullNumber: 42,
      htmlUrl: "https://github.com/mhk-repos/cp-medhok-monorepo/pull/42",
      title: "Fix issue",
      body: "",
      state: "open",
      draft: false,
      baseRef: "master",
      baseSha: "abc",
      headRef: "feature",
      headSha: "def",
      headOwner: "mhk-repos",
      headRepo: "cp-medhok-monorepo",
      headRepoFullName: "mhk-repos/cp-medhok-monorepo",
      author: "dev",
    };
    const review: CodexCodeReview = {
      verdict: "NEEDS_CHANGES",
      summary: "A fix is required.",
      jiraAskCoverage: [],
      missingOrIncorrect: [],
      ruleViolations: [],
      implementationFindings: [],
      testVerification: [],
      riskNotes: [],
      evidence: [],
    };

    expect(buildReviewJobOutputs(review, pr)).toEqual({
      verdict: "NEEDS_CHANGES",
      reviewed_head_sha: "def",
      apply_candidate: "true",
    });
    expect(
      buildReviewJobOutputs({ ...review, verdict: "APPROVED" }, pr)
        .apply_candidate,
    ).toBe("false");
    expect(
      buildReviewJobOutputs({ ...review, verdict: "BLOCKED" }, pr)
        .apply_candidate,
    ).toBe("false");
  });

  it("rejects applying an artifact after the PR head changes", () => {
    const reviewedPr: GitHubPullRequestInfo = {
      owner: "mhk-repos",
      repo: "cp-medhok-monorepo",
      pullNumber: 42,
      htmlUrl: "https://github.com/mhk-repos/cp-medhok-monorepo/pull/42",
      title: "Fix issue",
      body: "",
      state: "open",
      draft: false,
      baseRef: "master",
      baseSha: "abc",
      headRef: "feature",
      headSha: "reviewed-sha",
      headOwner: "mhk-repos",
      headRepo: "cp-medhok-monorepo",
      headRepoFullName: "mhk-repos/cp-medhok-monorepo",
      author: "dev",
    };
    const review: CodexCodeReview = {
      verdict: "NEEDS_CHANGES",
      summary: "A fix is required.",
      jiraAskCoverage: [],
      missingOrIncorrect: [],
      ruleViolations: [],
      implementationFindings: [],
      testVerification: [],
      riskNotes: [],
      evidence: [],
    };

    expect(() =>
      assertApplyEligibility({
        review,
        reviewedPr,
        currentPr: reviewedPr,
      }),
    ).not.toThrow();
    expect(() =>
      assertApplyEligibility({
        review,
        reviewedPr,
        currentPr: { ...reviewedPr, headSha: "new-sha" },
      }),
    ).toThrow(/PR head changed after review/);
    expect(() =>
      assertApplyEligibility({
        review: { ...review, verdict: "APPROVED" },
        reviewedPr,
        currentPr: reviewedPr,
      }),
    ).toThrow(/requires a NEEDS_CHANGES review/);
  });

  it("collects root, nested, and convention-based rule files for changed paths", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codex-code-review-test-"));
    try {
      await writeFile(path.join(root, ".clinerules"), "root rules", "utf8");
      await writeFile(path.join(root, "AGENTS.md"), "agent rules", "utf8");
      await mkdir(path.join(root, ".cursor", "rules"), { recursive: true });
      await writeFile(
        path.join(root, ".cursor", "rules", "java.mdc"),
        "cursor rules",
        "utf8",
      );
      await mkdir(path.join(root, "MedicalMgmt"), { recursive: true });
      await writeFile(
        path.join(root, "MedicalMgmt", ".clinerules"),
        "medical rules",
        "utf8",
      );
      await mkdir(path.join(root, "MedicalMgmt", "src"), { recursive: true });

      const rules = await collectReviewRules(root, [
        "MedicalMgmt/src/main/java/Foo.java",
      ]);

      expect(rules.map((rule) => rule.path)).toEqual([
        ".clinerules",
        "AGENTS.md",
        "MedicalMgmt/.clinerules",
        ".cursor/rules/java.mdc",
      ]);
      expect(rules.map((rule) => rule.content)).toContain("medical rules");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("renders a concise markdown summary", () => {
    const pr: GitHubPullRequestInfo = {
      owner: "mhk-repos",
      repo: "cp-medhok-monorepo",
      pullNumber: 42,
      htmlUrl: "https://github.com/mhk-repos/cp-medhok-monorepo/pull/42",
      title: "Fix issue",
      body: "",
      state: "open",
      draft: false,
      baseRef: "master",
      baseSha: "abc",
      headRef: "feature",
      headSha: "def",
      headOwner: "mhk-repos",
      headRepo: "cp-medhok-monorepo",
      headRepoFullName: "mhk-repos/cp-medhok-monorepo",
      author: "dev",
    };
    const review: CodexCodeReview = {
      verdict: "NEEDS_CHANGES",
      summary: "The implementation misses one acceptance criterion.",
      jiraAskCoverage: [
        {
          requirement: "Add validation",
          status: "missing",
          evidence: "No validation branch appears in the diff.",
        },
      ],
      missingOrIncorrect: [],
      ruleViolations: [],
      implementationFindings: [],
      testVerification: [],
      riskNotes: [],
      evidence: ["Reviewed PR diff and Jira description."],
    };

    const markdown = renderReviewMarkdown({
      jiraTicket: "CPDEV-12345",
      pr,
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
      review,
      rules: [{ path: ".clinerules", content: "rules", truncated: false }],
      usage: {
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cachedInputTokens: 250_000,
        cacheWriteTokens: 0,
        totalTokens: 1_100_000,
        estimatedCostUsd: 6.875,
      },
    });

    expect(markdown).toContain("# Codex-Code-Review Summary");
    expect(markdown).toContain("Verdict: **NEEDS_CHANGES**");
    expect(markdown).toContain("## Model Usage");
    expect(markdown).toContain(
      "| Review | 1,000,000 | 250,000 | 0 | 100,000 | 1,100,000 | $6.875000 |",
    );
    expect(markdown).toContain("`.clinerules`");
  });
});
