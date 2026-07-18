import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Database } from "../orchestrator/database.js";
import type { OneShotConsumerConfig } from "./config.js";
import {
  validateOneShotConsumerRuntime,
  validateQualifierRuntime,
} from "./runtime-validation.js";
import {
  DEFAULT_ONESHOT_PLANNER_PLUGIN_PATH,
  ONESHOT_PLANNER_SKILL_NAMES,
} from "./planner-plugin.js";

function createMockDatabase(
  options: {
    tables?: string[];
    columns?: string[];
    statusColumnType?: string | null;
    resultKeyStyle?: "camel" | "legacy";
    directTables?: string[];
    directColumns?: string[];
  } = {},
): Database {
  const tables = options.tables ?? [
    "oneshot_run_groups",
    "oneshot_runs",
    "oneshot_artifacts",
    "oneshot_notifications",
    "oneshot_run_events",
    "router_decisions",
    "router_confirmations",
    "historical_ticket_index",
  ];
  const columns = options.columns ?? [
    "run_group_id",
    "epic_key",
    "planning_attempt_count",
    "implementation_attempt_count",
    "code_review_attempt_count",
  ];
  const statusColumnType =
    options.statusColumnType ??
    "enum('assigned','in_progress','waiting_repo_confirmation','completed','failed','failed_retries_exhausted','posting_to_jira','posted_to_jira')";
  const resultKeyStyle = options.resultKeyStyle ?? "camel";
  const directTables = new Set(options.directTables ?? tables);
  const directColumns = new Set(options.directColumns ?? columns);

  const query = vi.fn(async (sql: string) => {
    if (sql.includes("SELECT DATABASE()")) {
      return [[{ dbName: "Specter" }], undefined];
    }
    if (sql.includes("FROM information_schema.tables")) {
      return [
        [
          tables.map((tableName) =>
            resultKeyStyle === "camel"
              ? { tableName }
              : { table_name: tableName },
          ),
        ].flat(),
        undefined,
      ];
    }
    if (sql.includes("FROM information_schema.columns")) {
      if (sql.includes("table_name = 'task_management'")) {
        return [
          statusColumnType
            ? [
                resultKeyStyle === "camel"
                  ? { columnType: statusColumnType }
                  : { column_type: statusColumnType },
              ]
            : [],
          undefined,
        ];
      }
      return [
        [
          columns.map((columnName) =>
            resultKeyStyle === "camel"
              ? { columnName }
              : { column_name: columnName },
          ),
        ].flat(),
        undefined,
      ];
    }
    const tableProbe = sql.match(/SELECT 1 FROM `([^`]+)` LIMIT 0/);
    if (tableProbe) {
      if (directTables.has(tableProbe[1])) {
        return [[], undefined];
      }
      const error = new Error(`Table ${tableProbe[1]} not found`) as Error & {
        code?: string;
      };
      error.code = "ER_NO_SUCH_TABLE";
      throw error;
    }
    const columnProbe = sql.match(/SELECT `([^`]+)` FROM `([^`]+)` LIMIT 0/);
    if (columnProbe) {
      const [, columnName, tableName] = columnProbe;
      if (!directTables.has(tableName)) {
        const error = new Error(`Table ${tableName} not found`) as Error & {
          code?: string;
        };
        error.code = "ER_NO_SUCH_TABLE";
        throw error;
      }
      if (directColumns.has(columnName)) {
        return [[], undefined];
      }
      const error = new Error(`Column ${columnName} not found`) as Error & {
        code?: string;
      };
      error.code = "ER_BAD_FIELD_ERROR";
      throw error;
    }
    throw new Error(`Unexpected SQL in test: ${sql}`);
  });

  return {
    getPool: () => ({ query }) as never,
  } as Database;
}

function createBaseConfig(
  overrides: Partial<OneShotConsumerConfig> = {},
): OneShotConsumerConfig {
  const promptLocalPath = overrides.promptLocalPath ?? "/tmp/oneshot-prompts";
  return {
    role: "PLANNER",
    region: "us-east-2",
    artifactBucket: "specter-results",
    artifactPrefix: "oneshot",
    maxReviewLoops: 3,
    maxVerificationLoops: 3,
    maxTotalTokens: 1000,
    maxStageTokens: {
      planning: 1000,
      review: 1000,
      implementation: 1000,
      code_review: 1000,
      testing: 1000,
    },
    maxStageAttempts: 5,
    reconcileStaleMinutes: 10,
    reviewerEnabled: true,
    codeReviewerEnabled: true,
    traceEnabled: true,
    tracePostToJira: true,
    implementationPlanPostToJira: true,
    verifyEnabled: true,
    verifyMode: "balanced",
    reviewStagesBlockOnExhaustion: false,
    reviewerProvider: "openai",
    reviewerModelId: undefined,
    codeReviewerProvider: "openai",
    codeReviewerModelId: undefined,
    plannerModelId: undefined,
    plannerMaxOutputTokens: 100_000,
    plannerMaxThinkingTokens: undefined,
    plannerMaxRepoToolCalls: 18,
    plannerMaxTurns: 40,
    implementerModelId: "us.anthropic.claude-sonnet-test",
    implementerMaxOutputTokens: 100_000,
    implementerMaxTurns: 180,
    codeReviewerMaxOutputTokens: 50_000,
    plannerClaudePermissionMode: "default",
    plannerClaudeToolVisibility: "restricted",
    plannerClaudeToolGuard: "enabled",
    plannerToolSprawlGuard: true,
    plannerSkillsEnabled: true,
    plannerSubagentsEnabled: true,
    plannerSubagentMaxTurns: 16,
    plannerPluginPath: path.join(promptLocalPath, "plugins", "oneshot-planner"),
    plannerScoutEnabled: false,
    plannerScoutModelId: "us.anthropic.claude-haiku-test-v1:0",
    sdkTraceMode: "failure",
    sdkStallThinkingPreview: "off",
    reviewerBypassReason: undefined,
    codeReviewerBypassReason: undefined,
    repoBasePath: "/tmp/repositories",
    repoAdminBasePath: "/tmp/repo-admin",
    repoCacheBasePath: "/tmp/oneshot/repos",
    workspaceBasePath: "/tmp/oneshot",
    worktreeBasePath: "/tmp/oneshot",
    promptSource: "local",
    promptBucket: "specter-results",
    promptManifestKey: "oneshot/manifest.json",
    promptManifestVersionId: undefined,
    promptCacheTtlMs: 1000,
    healthcareGuardrailsEnabled: false,
    promptLocalPath,
    planningQueueUrl: "https://example.com/planning.fifo",
    reviewQueueUrl: "https://example.com/review.fifo",
    implementationQueueUrl: "https://example.com/implementation.fifo",
    codeReviewQueueUrl: "https://example.com/code-review.fifo",
    testingQueueUrl: "https://example.com/testing.fifo",
    ...overrides,
  };
}

async function createLocalPromptTree(
  options: {
    includeSystemPrompt?: boolean;
    includePlannerPlugin?: boolean;
    includeRetrofitWorkflowPrompt?: boolean;
    buildPromptText?: string;
    reviewPlanPromptText?: string;
    reviewCodePromptText?: string;
  } = {},
): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "oneshot-prompts-"));
  await fs.mkdir(path.join(root, "prompts"), { recursive: true });
  await fs.mkdir(path.join(root, "guardrails"), { recursive: true });
  await fs.writeFile(path.join(root, "prompts", "plan.md"), "plan prompt");
  await fs.writeFile(
    path.join(root, "prompts", "review-plan.md"),
    options.reviewPlanPromptText ??
      "{{retrofitWorkflowSection}}\nreview prompt",
  );
  await fs.writeFile(
    path.join(root, "prompts", "build.md"),
    options.buildPromptText ??
      "{{mavenBuildsInstruction}}\n{{retrofitWorkflowSection}}\n{{retrofitAdaptationSection}}\nbuild prompt",
  );
  await fs.writeFile(
    path.join(root, "prompts", "review-code.md"),
    options.reviewCodePromptText ??
      "{{retrofitWorkflowSection}}\ncode review prompt",
  );
  if (options.includeRetrofitWorkflowPrompt !== false) {
    await fs.writeFile(
      path.join(root, "prompts", "retrofit-workflow.md"),
      "canonical retrofit workflow",
    );
  }
  await fs.writeFile(
    path.join(root, "guardrails", "plan-guardrails.md"),
    "plan guardrails",
  );
  await fs.writeFile(
    path.join(root, "guardrails", "review-plan-guardrails.md"),
    "review guardrails",
  );
  await fs.writeFile(
    path.join(root, "guardrails", "build-guardrails.md"),
    "build guardrails",
  );
  await fs.writeFile(
    path.join(root, "guardrails", "review-code-guardrails.md"),
    "code review guardrails",
  );
  if (options.includeSystemPrompt !== false) {
    await fs.writeFile(
      path.join(root, "prompts", "plan-system.md"),
      "plan system prompt",
    );
  }
  if (options.includePlannerPlugin !== false) {
    const pluginRoot = path.join(root, "plugins", "oneshot-planner");
    await fs.mkdir(path.join(pluginRoot, ".claude-plugin"), {
      recursive: true,
    });
    await fs.mkdir(path.join(pluginRoot, "skills"), { recursive: true });
    await fs.writeFile(
      path.join(pluginRoot, ".claude-plugin", "plugin.json"),
      JSON.stringify(
        {
          name: "oneshot-planner",
          version: "1.0.0",
          description: "OneShot planner Skills for grounded planning.",
          skills: "./skills",
        },
        null,
        2,
      ),
    );
    for (const skillName of ONESHOT_PLANNER_SKILL_NAMES) {
      await fs.mkdir(path.join(pluginRoot, "skills", skillName), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(pluginRoot, "skills", skillName, "SKILL.md"),
        [
          "---",
          `name: ${skillName}`,
          `description: ${skillName} guidance for OneShot planner tests.`,
          "---",
          "",
          `# ${skillName}`,
          "",
          "Use existing repository evidence before planning changes.",
        ].join("\n"),
      );
    }
  }
  return root;
}

function createClaudeExecutableValidator() {
  return vi.fn().mockResolvedValue({
    path: "/tmp/claude",
    source: "explicit_option",
    platform: "linux",
    arch: "x64",
    libc: "glibc",
    versionOutput: "claude-test 1.0",
  });
}

async function validateProductionPlannerRuntime(
  overrides: Partial<OneShotConsumerConfig> = {},
): Promise<void> {
  process.env.NODE_ENV = "production";
  process.env.ANTHROPIC_MODEL =
    "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
  process.env.GITHUB_REPO_TOKEN = "token";

  const promptRoot = await createLocalPromptTree();
  const repoAdminRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "repo-admin-"),
  );
  const workspaceRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "workspace-"),
  );

  await validateOneShotConsumerRuntime({
    db: createMockDatabase(),
    config: createBaseConfig({
      repoAdminBasePath: repoAdminRoot,
      workspaceBasePath: workspaceRoot,
      promptLocalPath: promptRoot,
      ...overrides,
    }),
    s3Client: { send: vi.fn().mockResolvedValue({}) } as never,
    sqsClient: {
      send: vi.fn().mockResolvedValue({
        Attributes: { QueueArn: "arn:aws:sqs:::planning" },
      }),
    } as never,
    claudeExecutableValidator: createClaudeExecutableValidator(),
  });
}

async function validateProductionReviewerRuntime(
  overrides: Partial<OneShotConsumerConfig> = {},
): Promise<void> {
  process.env.NODE_ENV = "production";
  process.env.OPENAI_API_KEY = "openai-key";
  process.env.OPENAI_REVIEWER_MODEL = "gpt-5.4";
  process.env.GITHUB_REPO_TOKEN = "token";

  const promptRoot = await createLocalPromptTree();
  const repoAdminRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "repo-admin-"),
  );
  const workspaceRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "workspace-"),
  );

  await validateOneShotConsumerRuntime({
    db: createMockDatabase(),
    config: createBaseConfig({
      role: "REVIEWER",
      repoAdminBasePath: repoAdminRoot,
      workspaceBasePath: workspaceRoot,
      promptLocalPath: promptRoot,
      ...overrides,
    }),
    s3Client: { send: vi.fn().mockResolvedValue({}) } as never,
    sqsClient: {
      send: vi.fn().mockResolvedValue({
        Attributes: { QueueArn: "arn:aws:sqs:::review" },
      }),
    } as never,
    claudeExecutableValidator: createClaudeExecutableValidator(),
  });
}

const ORIGINAL_ENV = { ...process.env };

describe("runtime validation", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it("validates the bundled planner plugin when cwd does not own the relative default path", async () => {
    const originalCwd = process.cwd();
    const unrelatedCwd = await fs.mkdtemp(path.join(os.tmpdir(), "not-repo-"));

    try {
      process.chdir(unrelatedCwd);
      await validateProductionPlannerRuntime({
        implementationPlanPostToJira: false,
        plannerPluginPath: DEFAULT_ONESHOT_PLANNER_PLUGIN_PATH,
        tracePostToJira: false,
      });
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("validates a planner runtime with local prompts and repo-admin path", async () => {
    process.env.ANTHROPIC_MODEL =
      "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
    process.env.GITHUB_REPO_TOKEN = "token";

    const promptRoot = await createLocalPromptTree();
    const repoAdminRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "repo-admin-"),
    );
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "workspace-"),
    );
    const db = createMockDatabase();
    const s3Client = { send: vi.fn().mockResolvedValue({}) } as never;
    const sqsClient = {
      send: vi.fn().mockResolvedValue({
        Attributes: { QueueArn: "arn:aws:sqs:::planning" },
      }),
    } as never;

    const claudeExecutableValidator = createClaudeExecutableValidator();

    await validateOneShotConsumerRuntime({
      db,
      config: createBaseConfig({
        repoAdminBasePath: repoAdminRoot,
        workspaceBasePath: workspaceRoot,
        promptLocalPath: promptRoot,
      }),
      s3Client,
      sqsClient,
      claudeExecutableValidator,
    });

    expect(s3Client.send).toHaveBeenCalledTimes(1);
    expect(sqsClient.send).toHaveBeenCalledTimes(1);
    expect(claudeExecutableValidator).toHaveBeenCalledTimes(1);
  });

  it("fails planner startup when Skills are enabled and plugin assets are missing", async () => {
    process.env.ANTHROPIC_MODEL =
      "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
    process.env.GITHUB_REPO_TOKEN = "token";

    const promptRoot = await createLocalPromptTree({
      includePlannerPlugin: false,
    });
    const repoAdminRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "repo-admin-"),
    );
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "workspace-"),
    );

    await expect(
      validateOneShotConsumerRuntime({
        db: createMockDatabase(),
        config: createBaseConfig({
          repoAdminBasePath: repoAdminRoot,
          workspaceBasePath: workspaceRoot,
          promptLocalPath: promptRoot,
        }),
        s3Client: { send: vi.fn().mockResolvedValue({}) } as never,
        sqsClient: {
          send: vi.fn().mockResolvedValue({
            Attributes: { QueueArn: "arn:aws:sqs:::planning" },
          }),
        } as never,
        claudeExecutableValidator: createClaudeExecutableValidator(),
      }),
    ).rejects.toThrow(/planner plugin/i);
  });

  it("skips planner plugin validation when Skills are disabled", async () => {
    process.env.ANTHROPIC_MODEL =
      "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
    process.env.GITHUB_REPO_TOKEN = "token";

    const promptRoot = await createLocalPromptTree({
      includePlannerPlugin: false,
    });
    const repoAdminRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "repo-admin-"),
    );
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "workspace-"),
    );
    const claudeExecutableValidator = createClaudeExecutableValidator();

    await validateOneShotConsumerRuntime({
      db: createMockDatabase(),
      config: createBaseConfig({
        repoAdminBasePath: repoAdminRoot,
        workspaceBasePath: workspaceRoot,
        promptLocalPath: promptRoot,
        plannerSkillsEnabled: false,
      }),
      s3Client: { send: vi.fn().mockResolvedValue({}) } as never,
      sqsClient: {
        send: vi.fn().mockResolvedValue({
          Attributes: { QueueArn: "arn:aws:sqs:::planning" },
        }),
      } as never,
      claudeExecutableValidator,
    });

    expect(claudeExecutableValidator).toHaveBeenCalledTimes(1);
  });

  it("fails startup when the required retrofit workflow prompt is missing", async () => {
    const promptRoot = await createLocalPromptTree({
      includeRetrofitWorkflowPrompt: false,
    });

    await expect(
      validateProductionPlannerRuntime({
        promptLocalPath: promptRoot,
        traceEnabled: false,
        tracePostToJira: false,
      }),
    ).rejects.toThrow(/retrofit-workflow/i);
  });

  it("fails startup when build.md lacks the retrofit workflow placeholder", async () => {
    const promptRoot = await createLocalPromptTree({
      buildPromptText:
        "{{mavenBuildsInstruction}}\n{{retrofitAdaptationSection}}\nbuild prompt",
    });

    await expect(
      validateProductionPlannerRuntime({
        promptLocalPath: promptRoot,
        traceEnabled: false,
        tracePostToJira: false,
      }),
    ).rejects.toThrow(/build\.md.*retrofitWorkflowSection/i);
  });

  it("fails startup when build.md lacks the retrofit adaptation placeholder", async () => {
    const promptRoot = await createLocalPromptTree({
      buildPromptText:
        "{{mavenBuildsInstruction}}\n{{retrofitWorkflowSection}}\nbuild prompt",
    });

    await expect(
      validateProductionPlannerRuntime({
        promptLocalPath: promptRoot,
        traceEnabled: false,
        tracePostToJira: false,
      }),
    ).rejects.toThrow(/build\.md.*retrofitAdaptationSection/i);
  });

  it("fails startup when review-plan.md lacks the retrofit workflow placeholder", async () => {
    const promptRoot = await createLocalPromptTree({
      reviewPlanPromptText: "review prompt",
    });

    await expect(
      validateProductionPlannerRuntime({
        promptLocalPath: promptRoot,
        traceEnabled: false,
        tracePostToJira: false,
      }),
    ).rejects.toThrow(/review-plan\.md.*retrofitWorkflowSection/i);
  });

  it("fails startup when review-code.md lacks the retrofit workflow placeholder", async () => {
    const promptRoot = await createLocalPromptTree({
      reviewCodePromptText: "code review prompt",
    });

    await expect(
      validateProductionPlannerRuntime({
        promptLocalPath: promptRoot,
        traceEnabled: false,
        tracePostToJira: false,
      }),
    ).rejects.toThrow(/review-code\.md.*retrofitWorkflowSection/i);
  });

  it("accepts GitHub App credentials for planner repository reads", async () => {
    process.env.ANTHROPIC_MODEL =
      "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
    process.env.GITHUB_APP_CREDENTIALS = JSON.stringify({
      appId: "12345",
      installationId: "67890",
      privateKey: "test-private-key",
    });
    delete process.env.GITHUB_REPO_TOKEN;

    const promptRoot = await createLocalPromptTree();
    const repoAdminRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "repo-admin-"),
    );
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "workspace-"),
    );
    const claudeExecutableValidator = createClaudeExecutableValidator();

    await validateOneShotConsumerRuntime({
      db: createMockDatabase(),
      config: createBaseConfig({
        repoAdminBasePath: repoAdminRoot,
        workspaceBasePath: workspaceRoot,
        promptLocalPath: promptRoot,
      }),
      s3Client: { send: vi.fn().mockResolvedValue({}) } as never,
      sqsClient: {
        send: vi.fn().mockResolvedValue({
          Attributes: { QueueArn: "arn:aws:sqs:::planning" },
        }),
      } as never,
      claudeExecutableValidator,
    });

    expect(claudeExecutableValidator).toHaveBeenCalledTimes(1);
  });

  it("fails production planner startup when TRACE Jira posting lacks credentials", async () => {
    process.env.NODE_ENV = "production";
    process.env.ANTHROPIC_MODEL =
      "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
    process.env.GITHUB_REPO_TOKEN = "token";
    delete process.env.JIRA_BASE_URL;
    delete process.env.JIRA_USERNAME;
    delete process.env.JIRA_TOKEN;

    const promptRoot = await createLocalPromptTree();
    const repoAdminRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "repo-admin-"),
    );
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "workspace-"),
    );

    await expect(
      validateOneShotConsumerRuntime({
        db: createMockDatabase(),
        config: createBaseConfig({
          repoAdminBasePath: repoAdminRoot,
          workspaceBasePath: workspaceRoot,
          promptLocalPath: promptRoot,
        }),
        s3Client: { send: vi.fn().mockResolvedValue({}) } as never,
        sqsClient: {
          send: vi.fn().mockResolvedValue({
            Attributes: { QueueArn: "arn:aws:sqs:::planning" },
          }),
        } as never,
        claudeExecutableValidator: createClaudeExecutableValidator(),
      }),
    ).rejects.toThrow(/JIRA_BASE_URL/);
  });

  it("allows production planner startup without Jira credentials when TRACE is disabled", async () => {
    delete process.env.JIRA_BASE_URL;
    delete process.env.JIRA_USERNAME;
    delete process.env.JIRA_TOKEN;

    await validateProductionPlannerRuntime({
      traceEnabled: false,
      tracePostToJira: true,
    });
  });

  it("allows production planner startup without Jira credentials when TRACE Jira posting is disabled", async () => {
    delete process.env.JIRA_BASE_URL;
    delete process.env.JIRA_USERNAME;
    delete process.env.JIRA_TOKEN;

    await validateProductionPlannerRuntime({
      traceEnabled: true,
      tracePostToJira: false,
    });
  });

  it("allows production planner startup with TRACE Jira posting and credentials", async () => {
    process.env.JIRA_BASE_URL = "https://jira.example.test";
    process.env.JIRA_USERNAME = "oneshot@example.test";
    process.env.JIRA_TOKEN = "jira-token";

    await validateProductionPlannerRuntime({
      traceEnabled: true,
      tracePostToJira: true,
    });
  });

  it("fails production reviewer startup when TRACE Jira posting lacks credentials", async () => {
    delete process.env.JIRA_BASE_URL;
    delete process.env.JIRA_USERNAME;
    delete process.env.JIRA_TOKEN;

    await expect(
      validateProductionReviewerRuntime({
        traceEnabled: true,
        tracePostToJira: true,
      }),
    ).rejects.toThrow(/JIRA_BASE_URL/);
  });

  it("allows production reviewer startup without Jira credentials when TRACE is disabled", async () => {
    delete process.env.JIRA_BASE_URL;
    delete process.env.JIRA_USERNAME;
    delete process.env.JIRA_TOKEN;

    await validateProductionReviewerRuntime({
      traceEnabled: false,
      tracePostToJira: true,
      implementationPlanPostToJira: false,
    });
  });

  it("allows production reviewer startup without Jira credentials when TRACE Jira posting is disabled", async () => {
    delete process.env.JIRA_BASE_URL;
    delete process.env.JIRA_USERNAME;
    delete process.env.JIRA_TOKEN;

    await validateProductionReviewerRuntime({
      traceEnabled: true,
      tracePostToJira: false,
      implementationPlanPostToJira: false,
    });
  });

  it("allows production reviewer startup with TRACE Jira posting and credentials", async () => {
    process.env.JIRA_BASE_URL = "https://jira.example.test";
    process.env.JIRA_USERNAME = "oneshot@example.test";
    process.env.JIRA_TOKEN = "jira-token";

    await validateProductionReviewerRuntime({
      traceEnabled: true,
      tracePostToJira: true,
    });
  });

  it("fails production reviewer startup when implementation plan Jira posting lacks credentials", async () => {
    delete process.env.JIRA_BASE_URL;
    delete process.env.JIRA_USERNAME;
    delete process.env.JIRA_TOKEN;

    await expect(
      validateProductionReviewerRuntime({
        traceEnabled: true,
        tracePostToJira: false,
        implementationPlanPostToJira: true,
      }),
    ).rejects.toThrow(/JIRA_BASE_URL/);
  });

  it("allows production reviewer startup without Jira credentials when implementation plan posting is disabled", async () => {
    delete process.env.JIRA_BASE_URL;
    delete process.env.JIRA_USERNAME;
    delete process.env.JIRA_TOKEN;

    await validateProductionReviewerRuntime({
      traceEnabled: true,
      tracePostToJira: false,
      implementationPlanPostToJira: false,
    });
  });

  it("validates resolved repo-cache and worktree paths instead of fallback roots", async () => {
    process.env.ANTHROPIC_MODEL =
      "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
    process.env.GITHUB_REPO_TOKEN = "token";

    const promptRoot = await createLocalPromptTree();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "oneshot-runtime-"));
    const repoAdminRoot = path.join(root, "repo-admin");
    const workspaceRoot = path.join(root, "legacy-workspace");
    const repoCacheRoot = path.join(root, "repo-cache");
    const worktreeRoot = path.join(root, "local-worktrees");
    await fs.mkdir(repoAdminRoot, { recursive: true });
    await fs.mkdir(workspaceRoot, { recursive: true });
    const claudeExecutableValidator = createClaudeExecutableValidator();

    await validateOneShotConsumerRuntime({
      db: createMockDatabase(),
      config: createBaseConfig({
        repoAdminBasePath: repoAdminRoot,
        repoCacheBasePath: repoCacheRoot,
        workspaceBasePath: workspaceRoot,
        worktreeBasePath: worktreeRoot,
        promptLocalPath: promptRoot,
      }),
      s3Client: { send: vi.fn().mockResolvedValue({}) } as never,
      sqsClient: {
        send: vi.fn().mockResolvedValue({
          Attributes: { QueueArn: "arn:aws:sqs:::planning" },
        }),
      } as never,
      claudeExecutableValidator,
    });

    expect((await fs.stat(repoCacheRoot)).isDirectory()).toBe(true);
    expect((await fs.stat(worktreeRoot)).isDirectory()).toBe(true);
  });

  it("validates an Anthropic reviewer without OpenAI env and checks Claude executable", async () => {
    process.env.ANTHROPIC_MODEL =
      "us.anthropic.claude-opus-4-6-v1";
    process.env.GITHUB_REPO_TOKEN = "token";
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_REVIEWER_MODEL;

    const promptRoot = await createLocalPromptTree();
    const repoAdminRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "repo-admin-"),
    );
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "workspace-"),
    );
    const claudeExecutableValidator = createClaudeExecutableValidator();

    await validateOneShotConsumerRuntime({
      db: createMockDatabase(),
      config: createBaseConfig({
        role: "REVIEWER",
        reviewerProvider: "anthropic",
        reviewerModelId: "us.anthropic.claude-opus-4-6-v1",
        repoAdminBasePath: repoAdminRoot,
        workspaceBasePath: workspaceRoot,
        promptLocalPath: promptRoot,
      }),
      s3Client: { send: vi.fn().mockResolvedValue({}) } as never,
      sqsClient: {
        send: vi.fn().mockResolvedValue({
          Attributes: { QueueArn: "arn:aws:sqs:::review" },
        }),
      } as never,
      claudeExecutableValidator,
    });

    expect(claudeExecutableValidator).toHaveBeenCalledTimes(1);
  });

  it("fails an OpenAI reviewer without OpenAI credentials and skips Claude executable validation", async () => {
    process.env.GITHUB_REPO_TOKEN = "token";
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_REVIEWER_MODEL;

    const promptRoot = await createLocalPromptTree();
    const repoAdminRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "repo-admin-"),
    );
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "workspace-"),
    );
    const claudeExecutableValidator = createClaudeExecutableValidator();

    await expect(
      validateOneShotConsumerRuntime({
        db: createMockDatabase(),
        config: createBaseConfig({
          role: "REVIEWER",
          reviewerProvider: "openai",
          repoAdminBasePath: repoAdminRoot,
          workspaceBasePath: workspaceRoot,
          promptLocalPath: promptRoot,
        }),
        s3Client: { send: vi.fn().mockResolvedValue({}) } as never,
        sqsClient: {
          send: vi.fn().mockResolvedValue({
            Attributes: { QueueArn: "arn:aws:sqs:::review" },
          }),
        } as never,
        claudeExecutableValidator,
      }),
    ).rejects.toThrow(/OPENAI_API_KEY/);

    expect(claudeExecutableValidator).not.toHaveBeenCalled();
  });

  it("validates an Anthropic code reviewer without OpenAI env and checks Claude executable", async () => {
    process.env.BEDROCK_MODEL = "us.anthropic.claude-opus-4-6-v1";
    process.env.GITHUB_REPO_TOKEN = "token";
    process.env.GITHUB_APP_CREDENTIALS = JSON.stringify({
      appId: "12345",
      installationId: "67890",
      privateKey: "test-private-key",
    });
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_CODE_REVIEWER_MODEL;

    const promptRoot = await createLocalPromptTree();
    const repoAdminRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "repo-admin-"),
    );
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "workspace-"),
    );
    const claudeExecutableValidator = createClaudeExecutableValidator();

    await validateOneShotConsumerRuntime({
      db: createMockDatabase(),
      config: createBaseConfig({
        role: "CODE_REVIEWER",
        codeReviewerProvider: "anthropic",
        codeReviewerModelId: "us.anthropic.claude-opus-4-6-v1",
        repoAdminBasePath: repoAdminRoot,
        workspaceBasePath: workspaceRoot,
        promptLocalPath: promptRoot,
      }),
      s3Client: { send: vi.fn().mockResolvedValue({}) } as never,
      sqsClient: {
        send: vi.fn().mockResolvedValue({
          Attributes: { QueueArn: "arn:aws:sqs:::code-review" },
        }),
      } as never,
      claudeExecutableValidator,
    });

    expect(claudeExecutableValidator).toHaveBeenCalledTimes(1);
  });

  it("fails planner startup when the planning system prompt asset is missing", async () => {
    process.env.ANTHROPIC_MODEL =
      "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
    process.env.GITHUB_REPO_TOKEN = "token";

    const promptRoot = await createLocalPromptTree({
      includeSystemPrompt: false,
    });
    const repoAdminRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "repo-admin-"),
    );
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "workspace-"),
    );

    await expect(
      validateOneShotConsumerRuntime({
        db: createMockDatabase(),
        config: createBaseConfig({
          repoAdminBasePath: repoAdminRoot,
          workspaceBasePath: workspaceRoot,
          promptLocalPath: promptRoot,
        }),
        s3Client: { send: vi.fn().mockResolvedValue({}) } as never,
        sqsClient: {
          send: vi.fn().mockResolvedValue({
            Attributes: { QueueArn: "arn:aws:sqs:::planning" },
          }),
        } as never,
        claudeExecutableValidator: createClaudeExecutableValidator(),
      }),
    ).rejects.toThrow(/plan-system/);
  });

  it("fails when the run-events migration is missing", async () => {
    process.env.ANTHROPIC_MODEL =
      "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
    process.env.GITHUB_REPO_TOKEN = "token";

    const promptRoot = await createLocalPromptTree();
    const repoAdminRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "repo-admin-"),
    );
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "workspace-"),
    );

    await expect(
      validateOneShotConsumerRuntime({
        db: createMockDatabase({
          tables: [
            "oneshot_run_groups",
            "oneshot_runs",
            "oneshot_artifacts",
            "oneshot_notifications",
          ],
        }),
        config: createBaseConfig({
          repoAdminBasePath: repoAdminRoot,
          workspaceBasePath: workspaceRoot,
          promptLocalPath: promptRoot,
        }),
        s3Client: { send: vi.fn().mockResolvedValue({}) } as never,
        sqsClient: { send: vi.fn().mockResolvedValue({}) } as never,
      }),
    ).rejects.toThrow(/missing required tables/i);
  });

  it("uses aliased result keys for information_schema queries", async () => {
    process.env.ANTHROPIC_MODEL =
      "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
    process.env.GITHUB_REPO_TOKEN = "token";

    const promptRoot = await createLocalPromptTree();
    const repoAdminRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "repo-admin-"),
    );
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "workspace-"),
    );

    await validateOneShotConsumerRuntime({
      db: createMockDatabase({
        resultKeyStyle: "camel",
      }),
      config: createBaseConfig({
        repoAdminBasePath: repoAdminRoot,
        workspaceBasePath: workspaceRoot,
        promptLocalPath: promptRoot,
      }),
      s3Client: { send: vi.fn().mockResolvedValue({}) } as never,
      sqsClient: {
        send: vi.fn().mockResolvedValue({
          Attributes: { QueueArn: "arn:aws:sqs:::planning" },
        }),
      } as never,
      claudeExecutableValidator: createClaudeExecutableValidator(),
    });
  });

  it("falls back to direct probes when information_schema is incomplete", async () => {
    process.env.ANTHROPIC_MODEL =
      "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
    process.env.GITHUB_REPO_TOKEN = "token";

    const promptRoot = await createLocalPromptTree();
    const repoAdminRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "repo-admin-"),
    );
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "workspace-"),
    );

    await validateOneShotConsumerRuntime({
      db: createMockDatabase({
        tables: [],
        columns: [],
	        directTables: [
	          "oneshot_run_groups",
	          "oneshot_runs",
	          "oneshot_artifacts",
	          "oneshot_notifications",
	          "oneshot_run_events",
	          "router_decisions",
	          "router_confirmations",
	          "historical_ticket_index",
	        ],
        directColumns: [
          "run_group_id",
          "epic_key",
          "planning_attempt_count",
          "implementation_attempt_count",
          "code_review_attempt_count",
        ],
      }),
      config: createBaseConfig({
        repoAdminBasePath: repoAdminRoot,
        workspaceBasePath: workspaceRoot,
        promptLocalPath: promptRoot,
      }),
      s3Client: { send: vi.fn().mockResolvedValue({}) } as never,
      sqsClient: {
        send: vi.fn().mockResolvedValue({
          Attributes: { QueueArn: "arn:aws:sqs:::planning" },
        }),
      } as never,
      claudeExecutableValidator: createClaudeExecutableValidator(),
    });
  });

  it("requires the planning queue for qualifier startup", async () => {
    process.env.ANTHROPIC_MODEL =
      "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
    process.env.GITHUB_REPO_TOKEN = "token";

    await expect(
      validateQualifierRuntime({
        db: createMockDatabase(),
        artifactBucket: "specter-results",
        planningQueueUrl: "",
        repoBasePath: await fs.mkdtemp(path.join(os.tmpdir(), "repos-")),
        repoAdminBasePath: await fs.mkdtemp(
          path.join(os.tmpdir(), "repo-admin-"),
        ),
        s3Client: { send: vi.fn().mockResolvedValue({}) } as never,
        sqsClient: { send: vi.fn().mockResolvedValue({}) } as never,
      }),
    ).rejects.toThrow(/ONESHOT_PLANNING_QUEUE_URL/);
  });
});
