import { beforeEach, describe, expect, it, vi } from "vitest";
import { SCRIBEAgent } from "./SCRIBEAgent.js";

const { runAgentMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
}));

vi.mock("../../claude-sdk/index.js", () => ({
  runAgent: runAgentMock,
  getAgentPrompt: vi.fn(() => "SCRIBE system prompt"),
  registerRepoFromPath: vi.fn(() => "repo-from-path"),
  registerCustomerWorkspace: vi.fn(() => ({
    workspaceId: "workspace-from-path",
    repoIds: ["core-app", "client-services"],
  })),
  SCRIBE_OUTPUT_SCHEMA: { type: "object" },
}));

function successfulAgentResult() {
  return {
    success: true,
    output: "explanation",
    structuredOutput: {
      summary: "endpoint behavior",
      how_it_works: {
        overview: "request flow",
        key_components: [
          {
            name: "CommonRestServices",
            file_path: "medhok-web-services/CommonRestServices.java",
            purpose: "REST entrypoint",
            how: "delegates to service layer",
          },
        ],
        execution_flow: ["REST request", "service lookup", "response mapping"],
      },
    },
    metrics: {
      durationMs: 1200,
      toolCalls: 8,
      tokensUsed: {
        input: 120,
        output: 60,
      },
    },
  };
}

describe("SCRIBEAgent runtime guardrails", () => {
  beforeEach(() => {
    runAgentMock.mockReset();
    runAgentMock.mockResolvedValue(successfulAgentResult());
  });

  it("passes bounded SDK runtime controls for code explanations", async () => {
    const agent = new SCRIBEAgent({
      repositoryPath: "/mnt/efs/specter-repo/repositories/tasks/CPCLIENT-1",
    });

    await agent.explain("Explain getModuleCaseByPageCriteria", "ticket context");

    expect(runAgentMock).toHaveBeenCalledTimes(1);
    const options = runAgentMock.mock.calls[0][0];
    expect(options).toMatchObject({
      agentType: "scribe",
      permissionLevel: "code_exploration",
      timeoutMs: 20 * 60 * 1000,
      maxTurns: 100,
      maxBudgetUsd: 6,
      includePartialMessages: true,
      idleTimeoutMs: 180_000,
      postToolIdleTimeoutMs: 90_000,
      toolIdleTimeoutMs: 600_000,
      sdkTraceMode: "failure",
      sdkStage: "scribe_explanation",
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
        maxCalls: 90,
      },
    });
    expect(options.claudeConfigDir).toContain("scribe");
  });
});
