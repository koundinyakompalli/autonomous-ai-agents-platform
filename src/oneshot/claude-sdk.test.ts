import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  latestQuery: vi.fn(),
  rootRunAgent: vi.fn(),
  registerRepoFromPath: vi.fn(),
}));

vi.mock("@specter/oneshot-claude-agent-sdk", () => ({
  query: mocks.latestQuery,
}));

vi.mock("../claude-sdk/index.js", () => ({
  parseJsonFromTextWithRepair: vi.fn(),
  parseJsonWithRepair: vi.fn(),
  parseValidatedJsonFromTextWithRepair: vi.fn(),
  registerRepoFromPath: mocks.registerRepoFromPath,
  runAgent: mocks.rootRunAgent,
}));

describe("oneshot claude sdk facade", () => {
  beforeEach(() => {
    mocks.latestQuery.mockReset();
    mocks.rootRunAgent.mockReset();
    mocks.registerRepoFromPath.mockReset();
    mocks.rootRunAgent.mockResolvedValue({
      success: true,
      output: "ok",
      toolCalls: 0,
      tokensUsed: 0,
      metrics: {},
    });
  });

  it("injects the pinned OneShot SDK binding by default", async () => {
    const { ONESHOT_CLAUDE_AGENT_SDK_ALIAS, runAgent } = await import(
      "./claude-sdk.js"
    );

    await runAgent({
      taskId: "oneshot-sdk-test",
      taskPrompt: "Run OneShot",
      repoIds: [],
      env: {},
    });

    expect(mocks.rootRunAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        sdkBinding: expect.objectContaining({
          query: mocks.latestQuery,
          sdkSource: "oneshot_latest",
          sdkPackageName: ONESHOT_CLAUDE_AGENT_SDK_ALIAS,
          sdkPackageVersion: "0.3.183",
        }),
      }),
    );
  });

  it("keeps the legacy shared SDK path when explicitly requested", async () => {
    const { ONESHOT_CLAUDE_AGENT_SDK_SOURCE_ENV, runAgent } = await import(
      "./claude-sdk.js"
    );

    await runAgent({
      taskId: "oneshot-sdk-legacy-test",
      taskPrompt: "Run OneShot",
      repoIds: [],
      env: {
        [ONESHOT_CLAUDE_AGENT_SDK_SOURCE_ENV]: "legacy",
      },
    });

    expect(mocks.rootRunAgent).toHaveBeenCalledWith(
      expect.not.objectContaining({
        sdkBinding: expect.anything(),
      }),
    );
  });

  it("re-exports shared repo registration helpers", async () => {
    const { registerRepoFromPath } = await import("./claude-sdk.js");

    registerRepoFromPath("workspace", "/tmp/workspace");

    expect(mocks.registerRepoFromPath).toHaveBeenCalledWith(
      "workspace",
      "/tmp/workspace",
    );
  });
});
