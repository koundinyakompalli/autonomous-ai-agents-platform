import { beforeEach, describe, expect, it, vi } from "vitest";
import { HERMESAgent } from "./HERMESAgent.js";

const { runAgentMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
}));

vi.mock("../../claude-sdk/index.js", () => ({
  runAgent: runAgentMock,
  getAgentPrompt: vi.fn(() => "HERMES system prompt"),
  registerRepoFromPath: vi.fn(() => "repo-from-path"),
  registerCustomerWorkspace: vi.fn(() => ({
    workspaceId: "workspace-from-path",
    repoIds: ["core-app", "mp-product-client-configs"],
  })),
  HERMES_OUTPUT_SCHEMA: { type: "object" },
}));

function successfulAgentResult() {
  return {
    success: true,
    output: "configuration",
    structuredOutput: {
      resolution_status: "found",
      configuration: {
        name: "SAMPLE_FLAG",
      },
      evidence: [
        {
          source_path: "config/system_variables.md",
          finding: "SAMPLE_FLAG is documented",
        },
      ],
      description: "sample flag",
    },
    metrics: {
      durationMs: 900,
      toolCalls: 4,
      tokensUsed: {
        input: 80,
        output: 40,
      },
    },
  };
}

describe("HERMESAgent runtime guardrails", () => {
  beforeEach(() => {
    runAgentMock.mockReset();
    runAgentMock.mockResolvedValue(successfulAgentResult());
  });

  it("passes tight SDK runtime controls for configuration lookup", async () => {
    const agent = new HERMESAgent({
      repositoryPath: "/mnt/efs/specter-repo/repositories/tasks/CPSUP-1",
    });

    await agent.findConfig("Find SAMPLE_FLAG", "customer context");

    expect(runAgentMock).toHaveBeenCalledTimes(1);
    const options = runAgentMock.mock.calls[0][0];
    expect(options).toMatchObject({
      agentType: "hermes",
      permissionLevel: "read_only",
      maxTurns: 60,
      maxBudgetUsd: 5,
      includePartialMessages: true,
      idleTimeoutMs: 120_000,
      postToolIdleTimeoutMs: 60_000,
      toolIdleTimeoutMs: 300_000,
      sdkTraceMode: "failure",
      sdkStage: "hermes_lookup",
      bedrockConfig: {
        maxOutputTokens: 50_000,
        maxThinkingTokens: 2_048,
      },
      toolSprawlGuard: {
        enabled: true,
        maxRepeatedSearches: 2,
        maxBroadSearches: 3,
      },
      toolBudgetGuard: {
        enabled: true,
        maxCalls: 60,
      },
    });
    expect(options.allowedBashCommandPatterns).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/rg/),
        expect.stringMatching(/find/),
      ]),
    );
    expect(options.claudeConfigDir).toContain("hermes");
    expect(options.additionalContext).toContain(
      "## HERMES Deterministic Config Index",
    );
    expect(options.additionalContext).toContain("customer context");
  });

  it("downgrades successful found output that lacks evidence sources", async () => {
    runAgentMock.mockResolvedValue({
      ...successfulAgentResult(),
      output: "This flag controls claims.",
      structuredOutput: {
        resolution_status: "found",
        configuration: {
          name: "SAMPLE_FLAG",
        },
        description: "sample flag",
      },
    });
    const agent = new HERMESAgent({ repoId: "core-app" });

    const result = await agent.findConfig("Find SAMPLE_FLAG");

    expect(result.success).toBe(false);
    expect(result.error).toContain("missing evidence");
  });

  it("retries once with quality-gate instructions before failing incomplete config output", async () => {
    runAgentMock
      .mockResolvedValueOnce({
        ...successfulAgentResult(),
        output: "This flag controls claims.",
        structuredOutput: {
          resolution_status: "found",
          configuration: {
            name: "SAMPLE_FLAG",
          },
          description: "sample flag",
        },
      })
      .mockResolvedValueOnce(successfulAgentResult());
    const agent = new HERMESAgent({ repoId: "core-app" });

    const result = await agent.findConfig("Find SAMPLE_FLAG");

    expect(result.success).toBe(true);
    expect(runAgentMock).toHaveBeenCalledTimes(2);
    expect(runAgentMock.mock.calls[1][0].additionalContext).toContain(
      "## HERMES Quality Gate Retry",
    );
    expect(runAgentMock.mock.calls[1][0].additionalContext).toContain(
      "Previous output failed quality gate",
    );
  });
});
