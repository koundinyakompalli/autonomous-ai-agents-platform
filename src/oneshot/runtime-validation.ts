import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { GetQueueAttributesCommand, SQSClient } from "@aws-sdk/client-sqs";
import * as fs from "fs/promises";
import * as path from "path";
import type mysql from "mysql2/promise";
import type { Database } from "../orchestrator/database.js";
import { createS3Client } from "../utils/awsClients.js";
import {
  validateOneShotClaudeExecutable,
  type ClaudeExecutableValidationResult,
} from "./claude-sdk.js";
import { createLogger } from "../utils/logger.js";
import { buildErrorLogFields } from "../utils/error-logging.js";
import type { OneShotConsumerConfig, OneShotSharedConfig } from "./config.js";
import { createPromptLoader } from "./prompt-loader.js";
import { STAGE_PROMPT_MAP } from "./prompt-types.js";
import {
  ONESHOT_PLANNER_PLUGIN_NAME,
  ONESHOT_PLANNER_SKILL_NAMES,
  resolveOneShotPlannerPluginPath,
} from "./planner-plugin.js";
import { validateRepoRouterSchema } from "./repo-router/schema-validation.js";
import { loadRepoRouterWeights } from "./repo-router/profile-loader.js";
import {
  hasGitHubWriteCredentials,
  hasGitHubReadCredentials,
} from "./github-app-auth.js";

const logger = createLogger("oneshot-runtime-validation");

const REQUIRED_TABLES = [
  "oneshot_run_groups",
  "oneshot_runs",
  "oneshot_artifacts",
  "oneshot_notifications",
  "oneshot_run_events",
] as const;

const REQUIRED_RUN_COLUMNS = [
  "run_group_id",
  "epic_key",
  "planning_attempt_count",
  "implementation_attempt_count",
  "code_review_attempt_count",
] as const;

const ROLE_TO_STAGE = {
  PLANNER: "planning",
  REVIEWER: "review",
  IMPLEMENTER: "implementation",
  CODE_REVIEWER: "code_review",
} as const;

type OneShotStageRole = keyof typeof ROLE_TO_STAGE;
type ValidationContext = Record<string, unknown>;
type ClaudeExecutableValidator = () => Promise<ClaudeExecutableValidationResult>;

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required runtime environment variable: ${name}`);
  }
  return value;
}

function requireGitHubWriteCredentials(): void {
  if (!hasGitHubWriteCredentials()) {
    throw new Error(
      "GITHUB_WRITE_TOKEN or GITHUB_APP_CREDENTIALS is required for OneShot GitHub write operations",
    );
  }
}

function requireGitHubReadCredentials(): void {
  if (!hasGitHubReadCredentials()) {
    throw new Error(
      "GITHUB_REPO_TOKEN or GITHUB_APP_CREDENTIALS is required for OneShot GitHub read operations",
    );
  }
}

async function getCurrentDatabaseName(pool: mysql.Pool): Promise<string> {
  const [rows] = await pool.query<
    Array<mysql.RowDataPacket & { dbName: string | null }>
  >("SELECT DATABASE() AS dbName");
  const dbName = rows[0]?.dbName?.trim();
  if (!dbName) {
    throw new Error(
      "Could not determine active database name for OneShot runtime validation",
    );
  }
  return dbName;
}

async function validateSchema(pool: mysql.Pool): Promise<void> {
  const dbName = await getCurrentDatabaseName(pool);

  const [tableRows] = await pool.query<
    Array<mysql.RowDataPacket & { tableName: string }>
  >(
    `SELECT table_name AS tableName
       FROM information_schema.tables
      WHERE table_schema = ?
        AND table_name IN (${REQUIRED_TABLES.map(() => "?").join(", ")})`,
    [dbName, ...REQUIRED_TABLES],
  );

  const presentTables = new Set(tableRows.map((row) => row.tableName));
  const missingTables = REQUIRED_TABLES.filter(
    (table) => !presentTables.has(table),
  );
  if (missingTables.length > 0) {
    for (const table of missingTables) {
      if (await canQueryTable(pool, table)) {
        presentTables.add(table);
      }
    }
  }

  const unresolvedTables = REQUIRED_TABLES.filter(
    (table) => !presentTables.has(table),
  );
  if (unresolvedTables.length > 0) {
    throw new Error(
      `OneShot runtime validation failed: missing required tables ${unresolvedTables.join(", ")} in schema ${dbName}. ` +
        "Run the OneShot migrations before starting this service.",
    );
  }

  const [columnRows] = await pool.query<
    Array<mysql.RowDataPacket & { columnName: string }>
  >(
    `SELECT column_name AS columnName
       FROM information_schema.columns
      WHERE table_schema = ?
        AND table_name = 'oneshot_runs'
        AND column_name IN (${REQUIRED_RUN_COLUMNS.map(() => "?").join(", ")})`,
    [dbName, ...REQUIRED_RUN_COLUMNS],
  );

  const presentColumns = new Set(columnRows.map((row) => row.columnName));
  const missingColumns = REQUIRED_RUN_COLUMNS.filter(
    (column) => !presentColumns.has(column),
  );
  if (missingColumns.length > 0) {
    for (const column of missingColumns) {
      if (await canQueryColumn(pool, "oneshot_runs", column)) {
        presentColumns.add(column);
      }
    }
  }

  const unresolvedColumns = REQUIRED_RUN_COLUMNS.filter(
    (column) => !presentColumns.has(column),
  );
  if (unresolvedColumns.length > 0) {
    throw new Error(
      `OneShot runtime validation failed: missing required oneshot_runs columns ${unresolvedColumns.join(", ")}. ` +
        "Run migration 012 before starting this service.",
    );
  }
}

async function canQueryTable(
  pool: mysql.Pool,
  tableName: string,
): Promise<boolean> {
  try {
    await pool.query(`SELECT 1 FROM \`${tableName}\` LIMIT 0`);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException & { code?: string }).code;
    if (code === "ER_NO_SUCH_TABLE") {
      return false;
    }
    throw error;
  }
}

async function canQueryColumn(
  pool: mysql.Pool,
  tableName: string,
  columnName: string,
): Promise<boolean> {
  try {
    await pool.query(`SELECT \`${columnName}\` FROM \`${tableName}\` LIMIT 0`);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException & { code?: string }).code;
    if (code === "ER_BAD_FIELD_ERROR" || code === "ER_NO_SUCH_TABLE") {
      return false;
    }
    throw error;
  }
}

async function validateDirectoryExists(
  dirPath: string,
  label: string,
): Promise<void> {
  let stats;
  try {
    stats = await fs.stat(dirPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(
        `OneShot runtime validation failed: ${label} does not exist at ${dirPath}`,
      );
    }
    throw error;
  }

  if (!stats.isDirectory()) {
    throw new Error(
      `OneShot runtime validation failed: ${label} is not a directory at ${dirPath}`,
    );
  }
}

async function validateWorkspaceBasePath(
  workspaceBasePath: string,
): Promise<void> {
  await fs.mkdir(workspaceBasePath, { recursive: true });
  await validateDirectoryExists(workspaceBasePath, "workspace base path");
}

async function validateBucketAccessible(
  s3Client: S3Client,
  bucket: string,
): Promise<void> {
  await s3Client.send(new HeadBucketCommand({ Bucket: bucket }));
}

async function validateQueueAccessible(
  sqsClient: SQSClient,
  queueUrl: string,
): Promise<void> {
  await sqsClient.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ["QueueArn"],
    }),
  );
}

async function validatePromptAssets(
  config: OneShotSharedConfig,
  stage: (typeof ROLE_TO_STAGE)[OneShotStageRole],
  s3Client: S3Client,
): Promise<void> {
  const mapping = STAGE_PROMPT_MAP[stage];
  const loader = createPromptLoader(config, s3Client);

  await loader.loadPrompt(mapping.prompt);
  await loader.loadGuardrail(mapping.guardrail);

  if (mapping.systemPrompt) {
    await loader.loadPrompt(mapping.systemPrompt);
  }

  if (config.healthcareGuardrailsEnabled) {
    await loader.loadGuardrail("healthcare-rules");
  }

  await validateRetrofitWorkflowPromptAssets(loader);
}

async function validateRetrofitWorkflowPromptAssets(
  loader: ReturnType<typeof createPromptLoader>,
): Promise<void> {
  await loader.loadPrompt("retrofit-workflow");

  const requiredPlaceholders = [
    {
      asset: "build",
      label: "build.md",
      placeholders: ["retrofitWorkflowSection", "retrofitAdaptationSection"],
    },
    {
      asset: "review-plan",
      label: "review-plan.md",
      placeholders: ["retrofitWorkflowSection"],
    },
    {
      asset: "review-code",
      label: "review-code.md",
      placeholders: ["retrofitWorkflowSection"],
    },
  ];

  for (const requirement of requiredPlaceholders) {
    const promptText = await loader.loadPrompt(requirement.asset);
    for (const placeholder of requirement.placeholders) {
      assertPromptPlaceholderPresent(
        promptText,
        requirement.label,
        placeholder,
      );
    }
  }

  await validateDeadImplementerBuildPromptRemoved();
}

function assertPromptPlaceholderPresent(
  promptText: string,
  label: string,
  placeholder: string,
): void {
  const token = `{{${placeholder}}}`;
  if (!promptText.includes(token)) {
    throw new Error(
      `OneShot runtime validation failed: ${label} is missing required retrofit placeholder ${token}`,
    );
  }
}

async function validateDeadImplementerBuildPromptRemoved(): Promise<void> {
  const sourcePath = path.resolve(
    process.cwd(),
    "src/oneshot/providers/claude-implementer.ts",
  );
  let sourceText: string;
  try {
    sourceText = await fs.readFile(sourcePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return;
    }
    throw error;
  }

  if (/\bfunction\s+buildPrompt\s*\(/.test(sourceText)) {
    throw new Error(
      `OneShot runtime validation failed: dead implementer buildPrompt() function still exists at ${sourcePath}`,
    );
  }
}

async function readRequiredTextFile(
  filePath: string,
  label: string,
): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(
        `OneShot runtime validation failed: ${label} does not exist at ${filePath}`,
      );
    }
    throw error;
  }
}

function assertPlannerSkillFrontmatter(
  skillName: string,
  skillPath: string,
  content: string,
): void {
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!frontmatter) {
    throw new Error(
      `OneShot runtime validation failed: planner plugin Skill ${skillName} at ${skillPath} is missing YAML frontmatter`,
    );
  }
  const normalizedFrontmatter = `\n${frontmatter[1]}\n`;
  if (!new RegExp(`\\nname:\\s*${skillName}\\n`).test(normalizedFrontmatter)) {
    throw new Error(
      `OneShot runtime validation failed: planner plugin Skill ${skillName} at ${skillPath} has invalid name frontmatter`,
    );
  }
  if (!/\ndescription:\s*\S/.test(normalizedFrontmatter)) {
    throw new Error(
      `OneShot runtime validation failed: planner plugin Skill ${skillName} at ${skillPath} is missing description frontmatter`,
    );
  }
  if (/\b(?:TODO|TBD|PLACEHOLDER)\b/i.test(content)) {
    throw new Error(
      `OneShot runtime validation failed: planner plugin Skill ${skillName} at ${skillPath} contains placeholder text`,
    );
  }
}

async function validatePlannerPluginAssets(pluginPath: string): Promise<void> {
  const pluginRoot = path.resolve(pluginPath);
  await validateDirectoryExists(pluginRoot, "planner plugin directory");

  const manifestPath = path.join(pluginRoot, ".claude-plugin", "plugin.json");
  const manifestText = await readRequiredTextFile(
    manifestPath,
    "planner plugin manifest",
  );
  let manifest: { name?: string; skills?: string };
  try {
    manifest = JSON.parse(manifestText) as { name?: string; skills?: string };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `OneShot runtime validation failed: planner plugin manifest at ${manifestPath} is invalid JSON: ${message}`,
    );
  }
  if (manifest.name !== ONESHOT_PLANNER_PLUGIN_NAME) {
    throw new Error(
      `OneShot runtime validation failed: planner plugin manifest at ${manifestPath} must be named ${ONESHOT_PLANNER_PLUGIN_NAME}`,
    );
  }
  if (manifest.skills !== "./skills") {
    throw new Error(
      `OneShot runtime validation failed: planner plugin manifest at ${manifestPath} must point skills to ./skills`,
    );
  }

  const skillsRoot = path.join(pluginRoot, "skills");
  await validateDirectoryExists(skillsRoot, "planner plugin skills directory");
  for (const skillName of ONESHOT_PLANNER_SKILL_NAMES) {
    const skillPath = path.join(skillsRoot, skillName, "SKILL.md");
    const content = await readRequiredTextFile(
      skillPath,
      `planner plugin Skill ${skillName}`,
    );
    assertPlannerSkillFrontmatter(skillName, skillPath, content);
  }
}

function requireClaudeProviderEnv(): void {
  requireEnv(
    process.env.ANTHROPIC_MODEL?.trim() ? "ANTHROPIC_MODEL" : "BEDROCK_MODEL",
  );
}

function validateProviderEnvForRole(
  config: Pick<
    OneShotConsumerConfig,
    "role" | "reviewerProvider" | "codeReviewerProvider"
  >,
): void {
  requireGitHubReadCredentials();

  if (
    config.role === "IMPLEMENTER" ||
    config.role === "CODE_REVIEWER" ||
    config.role === "TESTER"
  ) {
    requireGitHubWriteCredentials();
  }

  if (config.role === "REVIEWER" && config.reviewerProvider === "openai") {
    requireEnv("OPENAI_API_KEY");
    requireEnv("OPENAI_REVIEWER_MODEL");
    return;
  }

  if (
    config.role === "CODE_REVIEWER" &&
    config.codeReviewerProvider === "openai"
  ) {
    requireEnv("OPENAI_API_KEY");
    requireEnv("OPENAI_CODE_REVIEWER_MODEL");
    return;
  }

  requireClaudeProviderEnv();
}

function validateTraceJiraPostingEnv(
  config: Pick<OneShotConsumerConfig, "role" | "traceEnabled" | "tracePostToJira">,
): void {
  const tracePostingRole =
    config.role === "PLANNER" || config.role === "REVIEWER";
  if (
    !tracePostingRole ||
    !config.traceEnabled ||
    !config.tracePostToJira ||
    process.env.NODE_ENV !== "production"
  ) {
    return;
  }

  requireEnv("JIRA_BASE_URL");
  requireEnv("JIRA_USERNAME");
  requireEnv("JIRA_TOKEN");
}

function validateImplementationPlanJiraPostingEnv(
  config: Pick<
    OneShotConsumerConfig,
    "role" | "implementationPlanPostToJira"
  >,
): void {
  if (
    config.role !== "REVIEWER" ||
    !config.implementationPlanPostToJira ||
    process.env.NODE_ENV !== "production"
  ) {
    return;
  }

  requireEnv("JIRA_BASE_URL");
  requireEnv("JIRA_USERNAME");
  requireEnv("JIRA_TOKEN");
}

function validateQualifierProviderEnv(): void {
  requireGitHubReadCredentials();
  requireEnv(
    process.env.ANTHROPIC_MODEL?.trim() ? "ANTHROPIC_MODEL" : "BEDROCK_MODEL",
  );
}

async function runValidationStep<T>(
  step: string,
  context: ValidationContext,
  fn: () => Promise<T> | T,
): Promise<T> {
  logger.info({ step, ...context }, "Starting OneShot runtime validation step");

  try {
    const result = await fn();
    logger.info(
      { step, ...context },
      "Completed OneShot runtime validation step",
    );
    return result;
  } catch (error) {
    logger.error(
      { step, ...context, ...buildErrorLogFields(error) },
      "OneShot runtime validation step failed",
    );
    throw error;
  }
}

export interface OneShotConsumerValidationOptions {
  db: Database;
  config: OneShotConsumerConfig;
  s3Client?: S3Client;
  sqsClient?: SQSClient;
  claudeExecutableValidator?: ClaudeExecutableValidator;
}

export interface QualifierValidationOptions {
  db: Database;
  artifactBucket: string;
  planningQueueUrl: string;
  repoBasePath: string;
  repoAdminBasePath: string;
  s3Client?: S3Client;
  sqsClient?: SQSClient;
}

export async function validateOneShotConsumerRuntime(
  options: OneShotConsumerValidationOptions,
): Promise<void> {
  const { db, config } = options;
  const s3Client = options.s3Client ?? createS3Client({ region: config.region });
  const sqsClient =
    options.sqsClient ?? new SQSClient({ region: config.region });
  const repoCacheBasePath = config.repoCacheBasePath;
  const worktreeBasePath = config.worktreeBasePath;
  const claudeExecutableValidator =
    options.claudeExecutableValidator ?? validateOneShotClaudeExecutable;

  const baseContext = {
    artifactBucket: config.artifactBucket,
    implementationPlanPostToJira: config.implementationPlanPostToJira,
    promptSource: config.promptSource,
    repoAdminBasePath: config.repoAdminBasePath,
    repoCacheBasePath,
    role: config.role,
    traceEnabled: config.traceEnabled,
    tracePostToJira: config.tracePostToJira,
    workspaceBasePath: config.workspaceBasePath,
    worktreeBasePath,
  };

  await runValidationStep("schema", baseContext, () =>
    validateSchema(db.getPool()),
  );
  await runValidationStep("repo_router_schema", baseContext, () =>
    validateRepoRouterSchema(db.getPool()),
  );
  await runValidationStep("artifact_bucket_access", baseContext, () =>
    validateBucketAccessible(s3Client, config.artifactBucket),
  );
  await runValidationStep(
    "queue_access",
    {
      ...baseContext,
      queueUrl: getQueueUrlForRole(config),
    },
    () => validateQueueAccessible(sqsClient, getQueueUrlForRole(config)),
  );
  await runValidationStep("repo_admin_path", baseContext, () =>
    validateDirectoryExists(config.repoAdminBasePath, "repo-admin base path"),
  );
  await runValidationStep("repo_cache_base_path", baseContext, () =>
    validateWorkspaceBasePath(repoCacheBasePath),
  );
  await runValidationStep("worktree_base_path", baseContext, () =>
    validateWorkspaceBasePath(worktreeBasePath),
  );
  await runValidationStep("provider_env", baseContext, () =>
    validateProviderEnvForRole(config),
  );
  if (config.role === "PLANNER" || config.role === "REVIEWER") {
    await runValidationStep("trace_jira_env", baseContext, () =>
      validateTraceJiraPostingEnv(config),
    );
  }
  if (config.role === "REVIEWER") {
    await runValidationStep("implementation_plan_jira_env", baseContext, () =>
      validateImplementationPlanJiraPostingEnv(config),
    );
  }

  const roleUsesClaude =
    config.role === "PLANNER" ||
    config.role === "IMPLEMENTER" ||
    (config.role === "REVIEWER" && config.reviewerProvider === "anthropic") ||
    (config.role === "CODE_REVIEWER" &&
      config.codeReviewerProvider === "anthropic");

  if (roleUsesClaude) {
    const claudeExecutable = await runValidationStep(
      "claude_executable",
      baseContext,
      claudeExecutableValidator,
    );
    logger.info(
      {
        ...baseContext,
        claudeExecutablePath: claudeExecutable.path,
        claudeExecutableSource: claudeExecutable.source,
        claudeExecutablePackageSpecifier: claudeExecutable.packageSpecifier,
        platform: claudeExecutable.platform,
        arch: claudeExecutable.arch,
        libc: claudeExecutable.libc,
        versionOutput: claudeExecutable.versionOutput,
      },
      "Claude Code executable runtime validation completed",
    );
  }

  if (config.role === "PLANNER" && config.plannerSkillsEnabled) {
    const plannerPluginPath = resolveOneShotPlannerPluginPath(
      config.plannerPluginPath,
    );
    await runValidationStep(
      "planner_plugin_assets",
      {
        ...baseContext,
        plannerPluginPath,
      },
      () => validatePlannerPluginAssets(plannerPluginPath),
    );
  }

  if (config.role !== "TESTER") {
    await runValidationStep(
      "prompt_assets",
      {
        ...baseContext,
        stage: ROLE_TO_STAGE[config.role as OneShotStageRole],
      },
      () =>
        validatePromptAssets(
          config,
          ROLE_TO_STAGE[config.role as OneShotStageRole],
          s3Client,
        ),
    );
  }

  logger.info(baseContext, "OneShot consumer runtime validation completed");
}

export async function validateQualifierRuntime(
  options: QualifierValidationOptions,
): Promise<void> {
  if (!options.planningQueueUrl.trim()) {
    throw new Error(
      "OneShot runtime validation failed: ONESHOT_PLANNING_QUEUE_URL is not configured for QUALIFIER",
    );
  }

  const s3Client =
    options.s3Client ??
    createS3Client({ region: process.env.AWS_REGION || "us-east-2" });
  const sqsClient =
    options.sqsClient ??
    new SQSClient({ region: process.env.AWS_REGION || "us-east-2" });

  const baseContext = {
    artifactBucket: options.artifactBucket,
    planningQueueUrl: options.planningQueueUrl,
    repoBasePath: path.resolve(options.repoBasePath),
    repoAdminBasePath: path.resolve(options.repoAdminBasePath),
    role: "QUALIFIER",
  };

  await runValidationStep("schema", baseContext, () =>
    validateSchema(options.db.getPool()),
  );
  await runValidationStep("repo_router_schema", baseContext, () =>
    validateRepoRouterSchema(options.db.getPool()),
  );
  await runValidationStep("repo_router_weights", baseContext, () =>
    loadRepoRouterWeights(undefined, {
      requireWeights: process.env.NODE_ENV === "production",
    }),
  );
  await runValidationStep("artifact_bucket_access", baseContext, () =>
    validateBucketAccessible(s3Client, options.artifactBucket),
  );
  await runValidationStep("planning_queue_access", baseContext, () =>
    validateQueueAccessible(sqsClient, options.planningQueueUrl),
  );
  await runValidationStep("legacy_repo_path", baseContext, () =>
    validateDirectoryExists(
      options.repoBasePath,
      "legacy repository base path",
    ),
  );
  await runValidationStep("repo_admin_path", baseContext, () =>
    validateDirectoryExists(options.repoAdminBasePath, "repo-admin base path"),
  );
  await runValidationStep("provider_env", baseContext, () =>
    validateQualifierProviderEnv(),
  );

  logger.info(baseContext, "Qualifier runtime validation completed");
}

function getQueueUrlForRole(config: OneShotConsumerConfig): string {
  switch (config.role) {
    case "PLANNER":
      return config.planningQueueUrl;
    case "REVIEWER":
      return config.reviewQueueUrl;
    case "IMPLEMENTER":
      return config.implementationQueueUrl;
    case "CODE_REVIEWER":
      return config.codeReviewQueueUrl;
    case "TESTER":
      return config.testingQueueUrl;
  }
}
