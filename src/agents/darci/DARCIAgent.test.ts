import { beforeEach, describe, expect, it, vi } from "vitest";
import { DARCIAgent } from "./DARCIAgent.js";

const { runAgentMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
}));

vi.mock("../../claude-sdk/index.js", () => ({
  runAgent: runAgentMock,
  getAgentPrompt: vi.fn(() => "DARCI system prompt"),
  registerRepoFromPath: vi.fn(() => "repo-from-path"),
  registerCustomerWorkspace: vi.fn(() => ({
    workspaceId: "workspace-from-path",
    repoIds: ["core-app", "provider-portal"],
  })),
  DARCI_OUTPUT_SCHEMA: { type: "object" },
}));

function successfulAgentResult() {
  return {
    success: true,
    output: "analysis",
    structuredOutput: {
      root_cause: {
        summary: "root cause",
        file_path: "core-app/AuthService.java",
      },
      evidence: [
        {
          file_path: "core-app/AuthService.java",
          line_numbers: "10-12",
          finding: "AuthService throws the ticket error",
        },
      ],
    },
    metrics: {
      durationMs: 1234,
      toolCalls: 7,
      tokensUsed: {
        input: 100,
        output: 50,
      },
      costUsd: 0.01,
    },
  };
}

describe("DARCIAgent runtime guardrails", () => {
  beforeEach(() => {
    runAgentMock.mockReset();
    runAgentMock.mockResolvedValue(successfulAgentResult());
  });

  it("passes bounded SDK runtime controls for full defect analysis", async () => {
    const agent = new DARCIAgent({
      repositoryPath: "/mnt/efs/specter-repo/repositories/tasks/CPDEV-1",
    });

    await agent.analyze("Investigate intermittent failure", "stack trace");

    expect(runAgentMock).toHaveBeenCalledTimes(1);
    const options = runAgentMock.mock.calls[0][0];
    expect(options).toMatchObject({
      agentType: "darci",
      permissionLevel: "analysis",
      maxTurns: 140,
      maxBudgetUsd: 12,
      includePartialMessages: true,
      idleTimeoutMs: 180_000,
      postToolIdleTimeoutMs: 90_000,
      toolIdleTimeoutMs: 600_000,
      sdkTraceMode: "failure",
      sdkStage: "darci_analysis",
      bedrockConfig: {
        maxOutputTokens: 50_000,
        maxThinkingTokens: 2_048,
      },
      toolSprawlGuard: {
        enabled: true,
        maxRepeatedSearches: 2,
        maxBroadSearches: 4,
      },
      toolBudgetGuard: {
        enabled: true,
        maxCalls: 120,
      },
    });
    expect(options.allowedBashCommandPatterns).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/git/),
        expect.stringMatching(/rg/),
      ]),
    );
    expect(options.claudeConfigDir).toContain("darci");
    expect(options.additionalContext).toContain(
      "## DARCI Deterministic Evidence Pack",
    );
    expect(options.additionalContext).toContain("stack trace");
  });

  it("downgrades successful output that lacks evidence citations", async () => {
    runAgentMock.mockResolvedValue({
      ...successfulAgentResult(),
      output: "The issue is probably in the login code.",
      structuredOutput: {
        root_cause: {
          summary: "Likely login problem",
        },
      },
    });
    const agent = new DARCIAgent({ repoId: "core-app" });

    const result = await agent.analyze("Login fails intermittently");

    expect(result.success).toBe(false);
    expect(result.error).toContain("missing evidence");
  });

  it("retries once with quality-gate instructions before failing incomplete output", async () => {
    runAgentMock
      .mockResolvedValueOnce({
        ...successfulAgentResult(),
        output: "The issue is probably in login code.",
        structuredOutput: {
          root_cause: {
            summary: "Likely login problem",
          },
        },
      })
      .mockResolvedValueOnce(successfulAgentResult());
    const agent = new DARCIAgent({ repoId: "core-app" });

    const result = await agent.analyze("Login fails intermittently");

    expect(result.success).toBe(true);
    expect(runAgentMock).toHaveBeenCalledTimes(2);
    expect(runAgentMock.mock.calls[1][0].additionalContext).toContain(
      "## DARCI Quality Gate Retry",
    );
    expect(runAgentMock.mock.calls[1][0].additionalContext).toContain(
      "Previous output failed quality gate",
    );
  });
});
