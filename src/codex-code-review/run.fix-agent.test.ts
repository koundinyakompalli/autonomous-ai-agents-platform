import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JiraTicketData } from "../orchestrator/JiraClient.js";
import type { CodexCodeReview, GitHubPullRequestInfo } from "./run.js";

const { openAiMock, responsesCreateMock } = vi.hoisted(() => {
  const responsesCreateMock = vi.fn();
  return {
    responsesCreateMock,
    openAiMock: vi.fn(function OpenAiMock() {
      return { responses: { create: responsesCreateMock } };
    }),
  };
});

vi.mock("openai", () => ({ default: openAiMock }));

const execFileAsync = promisify(execFile);
const originalEnv = { ...process.env };

async function runGit(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", root, ...args]);
  return stdout;
}

describe("Codex-Code-Review fix agent", () => {
  beforeEach(() => {
    responsesCreateMock.mockReset();
    openAiMock.mockClear();
    process.env = {
      ...originalEnv,
      OPENAI_API_KEY: "test-openai-key",
      CODEX_CODE_REVIEW_MAX_FIX_TOOL_ITERATIONS: "1",
    };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("forces a structured no-tools response when the tool budget is exhausted", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codex-fix-loop-test-"));
    try {
      await runGit(root, ["init"]);
      await runGit(root, ["config", "user.name", "Codex Test"]);
      await runGit(root, ["config", "user.email", "codex@example.com"]);
      await writeFile(path.join(root, "README.md"), "test\n", "utf8");
      await runGit(root, ["add", "-A"]);
      await runGit(root, ["commit", "-m", "base"]);
      const baseSha = (await runGit(root, ["rev-parse", "HEAD"])).trim();

      responsesCreateMock
        .mockResolvedValueOnce({
          output: [
            {
              type: "function_call",
              call_id: "status-call",
              name: "git_status",
              arguments: "{}",
            },
          ],
          usage: { input_tokens: 100, output_tokens: 10 },
        })
        .mockResolvedValueOnce({
          output_text: JSON.stringify({
            applied: false,
            summary: "Stopped at the configured tool budget.",
            changedFiles: [],
            verificationNotes: [],
            residualRisks: ["No fixes were applied."],
          }),
          usage: { input_tokens: 200, output_tokens: 20 },
        });

      const { callOpenAiFixAgent } = await import("./run.js");
      const pr: GitHubPullRequestInfo = {
        owner: "mhk-repos",
        repo: "example",
        pullNumber: 1,
        htmlUrl: "https://github.com/mhk-repos/example/pull/1",
        title: "Test PR",
        body: "",
        state: "open",
        draft: false,
        baseRef: "main",
        baseSha,
        headRef: "feature",
        headSha: baseSha,
        headOwner: "mhk-repos",
        headRepo: "example",
        headRepoFullName: "mhk-repos/example",
        author: "developer",
      };
      const ticket = {
        issue: { key: "CPDEV-1", fields: { summary: "Test" } },
        descriptionMarkdown: "Test description",
        comments: [],
        attachments: [],
        textAttachments: [],
        imageAttachments: [],
      } as JiraTicketData;
      const review: CodexCodeReview = {
        verdict: "NEEDS_CHANGES",
        summary: "Apply a fix.",
        jiraAskCoverage: [],
        missingOrIncorrect: [],
        ruleViolations: [],
        implementationFindings: [],
        testVerification: [],
        riskNotes: [],
        evidence: [],
      };

      const result = await callOpenAiFixAgent({
        jiraTicket: "CPDEV-1",
        ticket,
        pr,
        files: [],
        diff: "",
        rules: [],
        review,
        model: "gpt-5.5",
        reasoningEffort: "xhigh",
        workspacePath: root,
      });

      expect(result.result.applied).toBe(false);
      expect(result.usage).toMatchObject({
        inputTokens: 300,
        outputTokens: 30,
      });
      expect(responsesCreateMock).toHaveBeenCalledTimes(2);
      const finalRequest = responsesCreateMock.mock.calls[1]?.[0] as {
        input: Array<Record<string, unknown>>;
        tools?: unknown;
      };
      expect(finalRequest.tools).toBeUndefined();
      expect(JSON.stringify(finalRequest.input)).toContain(
        "tool-call budget is exhausted",
      );
      expect(finalRequest.input).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "function_call_output",
            call_id: "status-call",
          }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
