import { readFileSync } from "fs";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getOneShotConsumerConfig, getOneShotSharedConfig } from "./config.js";
import { DEFAULT_ONESHOT_PLANNER_PLUGIN_PATH } from "./planner-plugin.js";
import { ONE_SHOT_NOTIFICATION_TYPES } from "./types.js";

const ORIGINAL_ENV = { ...process.env };

describe("oneshot config", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllEnvs();
  });

  it("builds shared config without queue urls or role", () => {
    delete process.env.ONESHOT_PLANNING_QUEUE_URL;
    delete process.env.ONESHOT_REVIEW_QUEUE_URL;
    delete process.env.ONESHOT_IMPLEMENTATION_QUEUE_URL;
    delete process.env.ONESHOT_ROLE;

    const config = getOneShotSharedConfig();

    expect(config.artifactPrefix).toBe("oneshot");
    expect(config.maxReviewLoops).toBe(3);
    expect(config.maxTotalTokens).toBe(50_000_000);
    expect(config.maxStageTokens).toEqual({
      planning: 4_000_000,
      review: 2_000_000,
      implementation: 4_000_000,
      code_review: 2_000_000,
      testing: 2_000_000,
    });
    expect(config.reviewerEnabled).toBe(true);
    expect(config.codeReviewerEnabled).toBe(true);
    expect(config.traceEnabled).toBe(true);
    expect(config.tracePostToJira).toBe(true);
    expect(config.implementationPlanPostToJira).toBe(true);
    expect(config.verifyEnabled).toBe(true);
    expect(config.verifyMode).toBe("balanced");
    expect(config.reviewStagesBlockOnExhaustion).toBe(false);
    expect(config.plannerModelId).toBeUndefined();
    expect(config.plannerMaxOutputTokens).toBe(100_000);
    expect(config.plannerMaxThinkingTokens).toBeUndefined();
    expect(config.plannerMaxRepoToolCalls).toBe(18);
    expect(config.plannerMaxTurns).toBe(40);
    expect(config.implementerModelId).toBe("us.anthropic.claude-sonnet-5");
    expect(config.implementerMaxOutputTokens).toBe(100_000);
    expect(config.plannerClaudePermissionMode).toBe("default");
    expect(config.plannerClaudeToolVisibility).toBe("restricted");
    expect(config.plannerClaudeToolGuard).toBe("enabled");
    expect(config.plannerToolSprawlGuard).toBe(true);
    expect(config.plannerSkillsEnabled).toBe(true);
    expect(config.plannerSubagentsEnabled).toBe(true);
    expect(config.plannerSubagentMaxTurns).toBe(16);
    expect(config.plannerPluginPath).toBe(
      path.resolve(process.cwd(), DEFAULT_ONESHOT_PLANNER_PLUGIN_PATH),
    );
    expect(path.isAbsolute(config.plannerPluginPath)).toBe(true);
    expect(config.plannerScoutEnabled).toBe(true);
    expect(config.plannerScoutModelId).toBe(
      "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    );
    expect(config.sdkTraceMode).toBe("failure");
    expect(config.sdkStallThinkingPreview).toBe("off");
    expect(config.repoBasePath).toContain("specter-repo");
    expect(config.repoAdminBasePath).toBe(config.repoBasePath);
    expect(config.repoCacheBasePath).toBe(
      "/mnt/efs/specter-repo/oneshot/repos",
    );
    expect(config.worktreeBasePath).toBe("/mnt/efs/specter-repo/oneshot");
    expect(config.mavenBuildsEnabled).toBe(true);
    expect(config.workspaceLeaseTtlSeconds).toBe(2700);
    expect(config.workspaceLeaseHeartbeatSeconds).toBe(30);
    expect(config.retrofitRepoCacheLeaseWaitMs).toBe(300_000);
    expect(config.repoCacheFreshnessTtlMs).toBe(300_000);
  });

  it("requires queue urls and role for consumer config", () => {
    vi.stubEnv(
      "ONESHOT_PLANNING_QUEUE_URL",
      "https://sqs.us-east-2.amazonaws.com/123/planning.fifo",
    );
    vi.stubEnv(
      "ONESHOT_REVIEW_QUEUE_URL",
      "https://sqs.us-east-2.amazonaws.com/123/review.fifo",
    );
    vi.stubEnv(
      "ONESHOT_IMPLEMENTATION_QUEUE_URL",
      "https://sqs.us-east-2.amazonaws.com/123/implementation.fifo",
    );
    vi.stubEnv(
      "ONESHOT_CODE_REVIEW_QUEUE_URL",
      "https://sqs.us-east-2.amazonaws.com/123/code-review.fifo",
    );
    vi.stubEnv(
      "ONESHOT_TESTING_QUEUE_URL",
      "https://sqs.us-east-2.amazonaws.com/123/testing.fifo",
    );
    vi.stubEnv("ONESHOT_ROLE", "REVIEWER");

    const config = getOneShotConsumerConfig();

    expect(config.role).toBe("REVIEWER");
    expect(config.reviewQueueUrl).toContain("review.fifo");
    expect(config.codeReviewQueueUrl).toContain("code-review.fifo");
    expect(config.testingQueueUrl).toContain("testing.fifo");
  });

  it("parses reviewer feature flags from env", () => {
    vi.stubEnv("ONESHOT_REVIEWER_ENABLED", "false");
    vi.stubEnv("ONESHOT_CODE_REVIEWER_ENABLED", "0");
    vi.stubEnv("ONESHOT_TRACE_ENABLED", "false");
    vi.stubEnv("ONESHOT_TRACE_POST_TO_JIRA", "0");
    vi.stubEnv("ONESHOT_IMPLEMENTATION_PLAN_POST_TO_JIRA", "false");
    vi.stubEnv("ONESHOT_VERIFY_ENABLED", "false");
    vi.stubEnv("ONESHOT_VERIFY_MODE", "strict");
    vi.stubEnv("ONESHOT_REVIEW_STAGES_BLOCK_ON_EXHAUSTION", "true");

    const config = getOneShotSharedConfig();

    expect(config.reviewerEnabled).toBe(false);
    expect(config.codeReviewerEnabled).toBe(false);
    expect(config.traceEnabled).toBe(false);
    expect(config.tracePostToJira).toBe(false);
    expect(config.implementationPlanPostToJira).toBe(false);
    expect(config.verifyEnabled).toBe(false);
    expect(config.verifyMode).toBe("strict");
    expect(config.reviewStagesBlockOnExhaustion).toBe(true);
  });

  it("parses workspace lease settings from env", () => {
    vi.stubEnv("ONESHOT_MAVEN_BUILDS_ENABLED", "false");
    vi.stubEnv("ONESHOT_WORKSPACE_LEASE_TTL_SECONDS", "1800");
    vi.stubEnv("ONESHOT_WORKSPACE_LEASE_HEARTBEAT_SECONDS", "20");
    vi.stubEnv("ONESHOT_RETROFIT_REPO_CACHE_LEASE_WAIT_MS", "420000");
    vi.stubEnv("ONESHOT_REPO_CACHE_FRESHNESS_TTL_MS", "120000");
    vi.stubEnv("ONESHOT_REPO_CACHE_BASE", "/mnt/efs/oneshot/repos");
    vi.stubEnv("ONESHOT_WORKTREE_BASE", "/var/oneshot/workspaces");

    const config = getOneShotSharedConfig();

    expect(config.mavenBuildsEnabled).toBe(false);
    expect(config.workspaceLeaseTtlSeconds).toBe(1800);
    expect(config.workspaceLeaseHeartbeatSeconds).toBe(20);
    expect(config.retrofitRepoCacheLeaseWaitMs).toBe(420_000);
    expect(config.repoCacheFreshnessTtlMs).toBe(120_000);
    expect(config.repoCacheBasePath).toBe("/mnt/efs/oneshot/repos");
    expect(config.worktreeBasePath).toBe("/var/oneshot/workspaces");
  });

  it("defaults reviewer providers to openai when env not set", () => {
    delete process.env.ONESHOT_REVIEWER_PROVIDER;
    delete process.env.ONESHOT_CODE_REVIEWER_PROVIDER;
    delete process.env.ONESHOT_REVIEWER_MODEL_ID;
    delete process.env.ONESHOT_CODE_REVIEWER_MODEL_ID;

    const config = getOneShotSharedConfig();

    expect(config.reviewerProvider).toBe("openai");
    expect(config.codeReviewerProvider).toBe("openai");
    expect(config.reviewerModelId).toBeUndefined();
    expect(config.codeReviewerModelId).toBeUndefined();
  });

  it("parses anthropic reviewer provider + model id from env", () => {
    vi.stubEnv("ONESHOT_REVIEWER_PROVIDER", "anthropic");
    vi.stubEnv("ONESHOT_REVIEWER_MODEL_ID", "us.anthropic.claude-opus-4-6-v1");
    vi.stubEnv("ONESHOT_CODE_REVIEWER_PROVIDER", "anthropic");
    vi.stubEnv(
      "ONESHOT_CODE_REVIEWER_MODEL_ID",
      "us.anthropic.claude-opus-4-6-v1",
    );

    const config = getOneShotSharedConfig();

    expect(config.reviewerProvider).toBe("anthropic");
    expect(config.reviewerModelId).toBe("us.anthropic.claude-opus-4-6-v1");
    expect(config.codeReviewerProvider).toBe("anthropic");
    expect(config.codeReviewerModelId).toBe("us.anthropic.claude-opus-4-6-v1");
  });

  it("includes the implementation plan notification type", () => {
    expect(ONE_SHOT_NOTIFICATION_TYPES).toContain("implementation_plan_ready");
  });

  it("refuses to start when anthropic reviewer provider lacks a model id", () => {
    vi.stubEnv("ONESHOT_REVIEWER_PROVIDER", "anthropic");
    delete process.env.ONESHOT_REVIEWER_MODEL_ID;

    expect(() => getOneShotSharedConfig()).toThrow(
      /ONESHOT_REVIEWER_PROVIDER=anthropic requires ONESHOT_REVIEWER_MODEL_ID/,
    );
  });

  it("refuses to start when anthropic code-reviewer provider lacks a model id", () => {
    vi.stubEnv("ONESHOT_CODE_REVIEWER_PROVIDER", "anthropic");
    delete process.env.ONESHOT_CODE_REVIEWER_MODEL_ID;

    expect(() => getOneShotSharedConfig()).toThrow(
      /ONESHOT_CODE_REVIEWER_PROVIDER=anthropic requires ONESHOT_CODE_REVIEWER_MODEL_ID/,
    );
  });

  it("rejects invalid reviewer provider values", () => {
    vi.stubEnv("ONESHOT_REVIEWER_PROVIDER", "azure");

    expect(() => getOneShotSharedConfig()).toThrow(/Invalid reviewer provider/);
  });

  it("parses per-stage token budget overrides from env", () => {
    vi.stubEnv("ONESHOT_MAX_TOTAL_TOKENS", "12000000");
    vi.stubEnv("ONESHOT_MAX_STAGE_TOKENS_PLANNING", "1000000");
    vi.stubEnv("ONESHOT_MAX_STAGE_TOKENS_REVIEW", "1100000");
    vi.stubEnv("ONESHOT_MAX_STAGE_TOKENS_IMPLEMENTATION", "2200000");
    vi.stubEnv("ONESHOT_MAX_STAGE_TOKENS_CODE_REVIEW", "3300000");
    vi.stubEnv("ONESHOT_MAX_STAGE_TOKENS_TESTING", "4400000");

    const config = getOneShotSharedConfig();

    expect(config.maxTotalTokens).toBe(12_000_000);
    expect(config.maxStageTokens).toEqual({
      planning: 1_000_000,
      review: 1_100_000,
      implementation: 2_200_000,
      code_review: 3_300_000,
      testing: 4_400_000,
    });
  });

  it("uses planner model override only when configured", () => {
    vi.stubEnv(
      "ONESHOT_PLANNER_MODEL_ID",
      "us.anthropic.claude-opus-test-v1:0",
    );

    const config = getOneShotSharedConfig();

    expect(config.plannerModelId).toBe("us.anthropic.claude-opus-test-v1:0");
  });

  it("parses planner and implementer output caps from env", () => {
    vi.stubEnv("ONESHOT_PLANNER_MAX_OUTPUT_TOKENS", "32000");
    vi.stubEnv("ONESHOT_PLANNER_MAX_THINKING_TOKENS", "24000");
    vi.stubEnv("ONESHOT_PLANNER_MAX_REPO_TOOL_CALLS", "12");
    vi.stubEnv("ONESHOT_PLANNER_MAX_TURNS", "75");
    vi.stubEnv("ONESHOT_PLANNER_SUBAGENT_MAX_TURNS", "24");
    vi.stubEnv("ONESHOT_IMPLEMENTER_MODEL_ID", "us.anthropic.claude-sonnet-test");
    vi.stubEnv("ONESHOT_IMPLEMENTER_MAX_OUTPUT_TOKENS", "33000");
    vi.stubEnv("ONESHOT_IMPLEMENTER_MAX_TURNS", "500");

    const config = getOneShotSharedConfig();

    expect(config.plannerMaxOutputTokens).toBe(32_000);
    expect(config.plannerMaxThinkingTokens).toBe(24_000);
    expect(config.plannerMaxRepoToolCalls).toBe(12);
    expect(config.plannerMaxTurns).toBe(75);
    expect(config.plannerSubagentMaxTurns).toBe(24);
    expect(config.implementerModelId).toBe("us.anthropic.claude-sonnet-test");
    expect(config.implementerMaxOutputTokens).toBe(33_000);
    expect(config.implementerMaxTurns).toBe(500);
  });

  it("rejects invalid planner repo-tool budgets", () => {
    vi.stubEnv("ONESHOT_PLANNER_MAX_REPO_TOOL_CALLS", "0");

    expect(() => getOneShotSharedConfig()).toThrow(
      "Invalid positive integer for ONESHOT_PLANNER_MAX_REPO_TOOL_CALLS",
    );
  });

  it("rejects invalid planner max turns", () => {
    vi.stubEnv("ONESHOT_PLANNER_MAX_TURNS", "0");

    expect(() => getOneShotSharedConfig()).toThrow(
      "Invalid positive integer for ONESHOT_PLANNER_MAX_TURNS",
    );
  });

  it("rejects invalid planner subagent max turns", () => {
    vi.stubEnv("ONESHOT_PLANNER_SUBAGENT_MAX_TURNS", "0");

    expect(() => getOneShotSharedConfig()).toThrow(
      "Invalid positive integer for ONESHOT_PLANNER_SUBAGENT_MAX_TURNS",
    );
  });

  it("parses planner Skill and subagent flags from env", () => {
    vi.stubEnv("ONESHOT_PLANNER_SKILLS_ENABLED", "false");
    vi.stubEnv("ONESHOT_PLANNER_SUBAGENTS_ENABLED", "0");
    vi.stubEnv(
      "ONESHOT_PLANNER_PLUGIN_PATH",
      "/opt/oneshot/plugins/oneshot-planner",
    );

    const config = getOneShotSharedConfig();

    expect(config.plannerSkillsEnabled).toBe(false);
    expect(config.plannerSubagentsEnabled).toBe(false);
    expect(config.plannerPluginPath).toBe("/opt/oneshot/plugins/oneshot-planner");
  });

  it("wires planner Skill and subagent controls into Terraform ECS config", () => {
    const repoRoot = process.cwd();
    const oneshotEcs = readFileSync(
      path.join(repoRoot, "terraform", "oneshot-ecs.tf"),
      "utf8",
    );
    const variables = readFileSync(
      path.join(repoRoot, "terraform", "variables.tf"),
      "utf8",
    );

    for (const [envName, variableName] of [
      ["ONESHOT_PLANNER_SKILLS_ENABLED", "oneshot_planner_skills_enabled"],
      ["ONESHOT_PLANNER_SUBAGENTS_ENABLED", "oneshot_planner_subagents_enabled"],
      [
        "ONESHOT_PLANNER_SUBAGENT_MAX_TURNS",
        "oneshot_planner_subagent_max_turns",
      ],
      ["ONESHOT_PLANNER_PLUGIN_PATH", "oneshot_planner_plugin_path"],
      ["ONESHOT_PLANNER_SCOUT_ENABLED", "oneshot_planner_scout_enabled"],
    ] as const) {
      expect(oneshotEcs).toContain(envName);
      expect(oneshotEcs).toContain(`var.${variableName}`);
      expect(variables).toContain(`variable "${variableName}"`);
    }
    expect(variables).toMatch(
      /variable "oneshot_planner_scout_enabled" \{[\s\S]*?default\s+=\s+true[\s\S]*?\}/,
    );
  });

  it("parses planner scout fallback flags", () => {
    vi.stubEnv("ONESHOT_PLANNER_CLAUDE_PERMISSION_MODE", "bypassPermissions");
    vi.stubEnv(
      "ONESHOT_PLANNER_CLAUDE_TOOL_VISIBILITY",
      "legacyAllowedToolsOnly",
    );
    vi.stubEnv("ONESHOT_PLANNER_CLAUDE_TOOL_GUARD", "disabledWhenRestricted");
    vi.stubEnv("ONESHOT_PLANNER_TOOL_SPRAWL_GUARD", "false");
    vi.stubEnv("ONESHOT_PLANNER_SCOUT_ENABLED", "true");
    vi.stubEnv(
      "ONESHOT_PLANNER_SCOUT_MODEL_ID",
      "us.anthropic.claude-haiku-test-v1:0",
    );
    vi.stubEnv("ONESHOT_SDK_TRACE_MODE", "always");
    vi.stubEnv("ONESHOT_SDK_STALL_THINKING_PREVIEW", "tail");

    const config = getOneShotSharedConfig();

    expect(config.plannerClaudePermissionMode).toBe("bypassPermissions");
    expect(config.plannerClaudeToolVisibility).toBe("legacyAllowedToolsOnly");
    expect(config.plannerClaudeToolGuard).toBe("disabledWhenRestricted");
    expect(config.plannerToolSprawlGuard).toBe(false);
    expect(config.plannerScoutEnabled).toBe(true);
    expect(config.plannerScoutModelId).toBe(
      "us.anthropic.claude-haiku-test-v1:0",
    );
    expect(config.sdkTraceMode).toBe("always");
    expect(config.sdkStallThinkingPreview).toBe("tail");
  });

  it("allows disabling the default-on planner scout pass", () => {
    vi.stubEnv("ONESHOT_PLANNER_SCOUT_ENABLED", "false");

    const config = getOneShotSharedConfig();

    expect(config.plannerScoutEnabled).toBe(false);
  });

  it("normalizes the legacy Haiku 3.5 scout model default to Haiku 4.5", () => {
    vi.stubEnv(
      "ONESHOT_PLANNER_SCOUT_MODEL_ID",
      "us.anthropic.claude-3-5-haiku-20241022-v1:0",
    );

    const config = getOneShotSharedConfig();

    expect(config.plannerScoutModelId).toBe(
      "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    );
    expect(config.configWarnings).toContain(
      "planner_scout_model_legacy_haiku_3_5_normalized",
    );
  });

  it("preserves non-legacy explicit planner scout model overrides", () => {
    vi.stubEnv(
      "ONESHOT_PLANNER_SCOUT_MODEL_ID",
      "us.anthropic.claude-haiku-experimental-v9:0",
    );

    const config = getOneShotSharedConfig();

    expect(config.plannerScoutModelId).toBe(
      "us.anthropic.claude-haiku-experimental-v9:0",
    );
    expect(config.configWarnings ?? []).not.toContain(
      "planner_scout_model_legacy_haiku_3_5_normalized",
    );
  });

  it("rejects invalid planner Claude permission mode", () => {
    vi.stubEnv("ONESHOT_PLANNER_CLAUDE_PERMISSION_MODE", "danger");

    expect(() => getOneShotSharedConfig()).toThrow(
      "Invalid Claude permission mode for ONESHOT_PLANNER_CLAUDE_PERMISSION_MODE",
    );
  });

  it("rejects invalid planner Claude tool visibility", () => {
    vi.stubEnv("ONESHOT_PLANNER_CLAUDE_TOOL_VISIBILITY", "all");

    expect(() => getOneShotSharedConfig()).toThrow(
      "Invalid Claude tool visibility for ONESHOT_PLANNER_CLAUDE_TOOL_VISIBILITY",
    );
  });

  it("rejects invalid planner Claude tool guard", () => {
    vi.stubEnv("ONESHOT_PLANNER_CLAUDE_TOOL_GUARD", "off");

    expect(() => getOneShotSharedConfig()).toThrow(
      "Invalid Claude tool guard for ONESHOT_PLANNER_CLAUDE_TOOL_GUARD",
    );
  });

  it("rejects invalid SDK trace mode", () => {
    vi.stubEnv("ONESHOT_SDK_TRACE_MODE", "verbose");

    expect(() => getOneShotSharedConfig()).toThrow(
      "Invalid SDK trace mode for ONESHOT_SDK_TRACE_MODE",
    );
  });

  it("rejects invalid SDK stall thinking preview", () => {
    vi.stubEnv("ONESHOT_SDK_STALL_THINKING_PREVIEW", "full");

    expect(() => getOneShotSharedConfig()).toThrow(
      "Invalid SDK stall thinking preview for ONESHOT_SDK_STALL_THINKING_PREVIEW",
    );
  });

  it("uses explicit repo-admin path for oneshot when configured", () => {
    vi.stubEnv("REPOSITORY_PATH", "/mnt/efs/specter-repo/repositories");
    vi.stubEnv("ONESHOT_REPO_ADMIN_BASE", "/mnt/efs/specter-repo/repo-admin");

    const config = getOneShotSharedConfig();

    expect(config.repoBasePath).toBe("/mnt/efs/specter-repo/repositories");
    expect(config.repoAdminBasePath).toBe("/mnt/efs/specter-repo/repo-admin");
    expect(config.repoCacheBasePath).toBe(
      "/mnt/efs/specter-repo/oneshot/repos",
    );
  });

  it("requires the OneShot comment asset base URL in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.ONESHOT_COMMENT_ASSET_BASE_URL;
    vi.stubEnv(
      "ONESHOT_DASHBOARD_BASE_URL",
      "https://productFactory.mhkdevsandbox.com",
    );

    expect(() => getOneShotSharedConfig()).toThrow(
      "ONESHOT_COMMENT_ASSET_BASE_URL must be set in production",
    );
  });

  it("requires the OneShot dashboard base URL in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv(
      "ONESHOT_COMMENT_ASSET_BASE_URL",
      "https://productFactory.mhkdevsandbox.com",
    );
    delete process.env.ONESHOT_DASHBOARD_BASE_URL;

    expect(() => getOneShotSharedConfig()).toThrow(
      "ONESHOT_DASHBOARD_BASE_URL must be set in production",
    );
  });

  it("allows missing OneShot comment asset base URL outside production", () => {
    vi.stubEnv("NODE_ENV", "test");
    delete process.env.ONESHOT_COMMENT_ASSET_BASE_URL;
    delete process.env.ONESHOT_DASHBOARD_BASE_URL;

    const config = getOneShotSharedConfig();

    expect(config.commentAssetBaseUrl).toBeUndefined();
    expect(config.dashboardBaseUrl).toBeUndefined();
  });
});
