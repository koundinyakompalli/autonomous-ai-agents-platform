import * as path from "path";
import { z } from "zod";
import type {
  ClaudePermissionMode,
  ClaudeToolGuard,
  ClaudeToolVisibility,
  SdkStallThinkingPreview,
  SdkTraceMode,
} from "../claude-sdk/index.js";
import {
  ONE_SHOT_ARTIFACT_BUCKET_ENV,
  ONE_SHOT_ARTIFACT_PREFIX_ENV,
  ONE_SHOT_CODE_REVIEW_QUEUE_ENV,
  ONE_SHOT_CODE_REVIEWER_BYPASS_REASON_ENV,
  ONE_SHOT_CODE_REVIEWER_ENABLED_ENV,
  ONE_SHOT_IMPLEMENTATION_QUEUE_ENV,
  ONE_SHOT_IMPLEMENTER_MODEL_ID_ENV,
  ONE_SHOT_MAX_REVIEW_LOOPS_ENV,
  ONE_SHOT_MAX_STAGE_ATTEMPTS_ENV,
  ONE_SHOT_MAX_STAGE_TOKENS_CODE_REVIEW_ENV,
  ONE_SHOT_MAX_STAGE_TOKENS_IMPLEMENTATION_ENV,
  ONE_SHOT_MAX_STAGE_TOKENS_PLANNING_ENV,
  ONE_SHOT_MAX_STAGE_TOKENS_REVIEW_ENV,
  ONE_SHOT_MAX_STAGE_TOKENS_TESTING_ENV,
  ONE_SHOT_MAX_TOTAL_TOKENS_ENV,
  ONE_SHOT_IMPLEMENTER_MAX_OUTPUT_TOKENS_ENV,
  ONE_SHOT_IMPLEMENTER_MAX_TURNS_ENV,
  ONE_SHOT_MAVEN_BUILDS_ENABLED_ENV,
  ONE_SHOT_CODE_REVIEWER_MAX_OUTPUT_TOKENS_ENV,
  ONE_SHOT_MAX_VERIFICATION_LOOPS_ENV,
  ONE_SHOT_PLANNER_CLAUDE_PERMISSION_MODE_ENV,
  ONE_SHOT_PLANNER_CLAUDE_TOOL_GUARD_ENV,
  ONE_SHOT_PLANNER_CLAUDE_TOOL_VISIBILITY_ENV,
  ONE_SHOT_PLANNER_MAX_REPO_TOOL_CALLS_ENV,
  ONE_SHOT_PLANNER_MAX_THINKING_TOKENS_ENV,
  ONE_SHOT_PLANNER_MAX_TURNS_ENV,
  ONE_SHOT_PLANNER_MAX_OUTPUT_TOKENS_ENV,
  ONE_SHOT_PLANNER_MODEL_ID_ENV,
  ONE_SHOT_PLANNER_PLUGIN_PATH_ENV,
  ONE_SHOT_PLANNER_SCOUT_ENABLED_ENV,
  ONE_SHOT_PLANNER_SCOUT_MODEL_ID_ENV,
  ONE_SHOT_PLANNER_SKILLS_ENABLED_ENV,
  ONE_SHOT_PLANNER_SUBAGENT_MAX_TURNS_ENV,
  ONE_SHOT_PLANNER_SUBAGENTS_ENABLED_ENV,
  ONE_SHOT_PLANNER_TOOL_SPRAWL_GUARD_ENV,
  ONE_SHOT_PLANNING_QUEUE_ENV,
  ONE_SHOT_RECONCILE_STALE_MINUTES_ENV,
  ONE_SHOT_RETROFIT_REPO_CACHE_LEASE_WAIT_MS_ENV,
  ONE_SHOT_STALE_MINUTES_IMPLEMENTATION_ENV,
  ONE_SHOT_STALE_MINUTES_PLANNING_ENV,
  ONE_SHOT_STALE_MINUTES_TESTING_ENV,
  ONE_SHOT_REVIEW_STAGES_BLOCK_ON_EXHAUSTION_ENV,
  ONE_SHOT_REVIEWER_BYPASS_REASON_ENV,
  ONE_SHOT_REVIEWER_ENABLED_ENV,
  ONE_SHOT_TRACE_ENABLED_ENV,
  ONE_SHOT_IMPLEMENTATION_PLAN_POST_TO_JIRA_ENV,
  ONE_SHOT_TRACE_POST_TO_JIRA_ENV,
  ONE_SHOT_REVIEWER_PROVIDER_ENV,
  ONE_SHOT_REVIEWER_MODEL_ID_ENV,
  ONE_SHOT_CODE_REVIEWER_PROVIDER_ENV,
  ONE_SHOT_CODE_REVIEWER_MODEL_ID_ENV,
  ONE_SHOT_VERIFY_ENABLED_ENV,
  ONE_SHOT_VERIFY_MODE_ENV,
  ONE_SHOT_SDK_STALL_THINKING_PREVIEW_ENV,
  ONE_SHOT_SDK_TRACE_MODE_ENV,
  ONE_SHOT_REVIEW_QUEUE_ENV,
  ONE_SHOT_TESTING_QUEUE_ENV,
  type OneShotQueueStage,
} from "./contracts.js";
import {
  DEFAULT_ONESHOT_PLANNER_PLUGIN_PATH,
  resolveOneShotPlannerPluginPath,
} from "./planner-plugin.js";

const OneShotRoleSchema = z.enum([
  "PLANNER",
  "REVIEWER",
  "IMPLEMENTER",
  "CODE_REVIEWER",
  "TESTER",
]);
const ONE_SHOT_COMMENT_ASSET_BASE_URL_ENV = "ONESHOT_COMMENT_ASSET_BASE_URL";
const ONE_SHOT_DASHBOARD_BASE_URL_ENV = "ONESHOT_DASHBOARD_BASE_URL";
const DEFAULT_PLANNER_SCOUT_MODEL_ID =
  "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const LEGACY_PLANNER_SCOUT_MODEL_ID =
  "us.anthropic.claude-3-5-haiku-20241022-v1:0";
const LEGACY_PLANNER_SCOUT_MODEL_WARNING =
  "planner_scout_model_legacy_haiku_3_5_normalized";
const DEFAULT_IMPLEMENTER_MODEL_ID = "us.anthropic.claude-sonnet-5";

export type OneShotRole = z.infer<typeof OneShotRoleSchema>;

export type PromptSource = "s3" | "local";

export interface OneShotSharedConfig {
  region: string;
  artifactBucket: string;
  artifactPrefix: string;
  maxReviewLoops: number;
  maxVerificationLoops: number;
  maxTotalTokens: number;
  maxStageTokens: Record<OneShotQueueStage, number>;
  maxStageAttempts: number;
  reconcileStaleMinutes: number;
  staleMinutesImplementation: number;
  staleMinutesPlanning: number;
  staleMinutesTesting: number;
  reviewerEnabled: boolean;
  codeReviewerEnabled: boolean;
  traceEnabled: boolean;
  tracePostToJira: boolean;
  implementationPlanPostToJira: boolean;
  verifyEnabled: boolean;
  verifyMode: "balanced" | "strict" | "lenient";
  reviewStagesBlockOnExhaustion: boolean;
  reviewerProvider: "openai" | "anthropic";
  reviewerModelId: string | undefined;
  codeReviewerProvider: "openai" | "anthropic";
  codeReviewerModelId: string | undefined;
  plannerModelId: string | undefined;
  plannerMaxOutputTokens: number;
  plannerMaxThinkingTokens: number | undefined;
  plannerMaxRepoToolCalls: number;
  plannerMaxTurns: number;
  implementerModelId: string;
  implementerMaxOutputTokens: number;
  implementerMaxTurns: number;
  codeReviewerMaxOutputTokens: number;
  plannerClaudePermissionMode: ClaudePermissionMode;
  plannerClaudeToolVisibility: ClaudeToolVisibility;
  plannerClaudeToolGuard: ClaudeToolGuard;
  plannerToolSprawlGuard: boolean;
  plannerSkillsEnabled: boolean;
  plannerSubagentsEnabled: boolean;
  plannerSubagentMaxTurns: number;
  plannerPluginPath: string;
  plannerScoutEnabled: boolean;
  plannerScoutModelId: string;
  configWarnings?: string[];
  sdkTraceMode: SdkTraceMode;
  sdkStallThinkingPreview: SdkStallThinkingPreview;
  reviewerBypassReason: string | undefined;
  codeReviewerBypassReason: string | undefined;
  repoBasePath: string;
  repoAdminBasePath: string;
  repoCacheBasePath: string;
  workspaceBasePath: string;
  worktreeBasePath: string;
  mavenBuildsEnabled: boolean;
  workspaceLeaseTtlSeconds: number;
  workspaceLeaseHeartbeatSeconds: number;
  retrofitRepoCacheLeaseWaitMs: number;
  repoCacheFreshnessTtlMs: number;
  promptSource: PromptSource;
  promptBucket: string;
  promptManifestKey: string;
  promptManifestVersionId: string | undefined;
  promptCacheTtlMs: number;
  healthcareGuardrailsEnabled: boolean;
  promptLocalPath: string;
  commentAssetBaseUrl: string | undefined;
  dashboardBaseUrl: string | undefined;
}

export interface OneShotQueueConfig extends OneShotSharedConfig {
  role?: OneShotRole;
  planningQueueUrl: string;
  reviewQueueUrl: string;
  implementationQueueUrl: string;
  codeReviewQueueUrl: string;
  testingQueueUrl: string;
}

export interface OneShotConsumerConfig extends OneShotQueueConfig {
  role: OneShotRole;
}

function getRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required OneShot environment variable: ${name}`);
  }
  return value;
}

function getBooleanEnv(name: string, defaultValue: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) {
    return defaultValue;
  }

  if (["1", "true", "yes", "on"].includes(value)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(value)) {
    return false;
  }

  throw new Error(`Invalid boolean value for ${name}: ${process.env[name]}`);
}

function getPlannerClaudePermissionModeEnv(
  name: string,
  defaultValue: ClaudePermissionMode,
): ClaudePermissionMode {
  const value = process.env[name]?.trim() || defaultValue;
  if (
    value === "default" ||
    value === "acceptEdits" ||
    value === "bypassPermissions"
  ) {
    return value;
  }

  throw new Error(
    `Invalid Claude permission mode for ${name}: ${process.env[name]}. ` +
      "Expected one of: default, acceptEdits, bypassPermissions.",
  );
}

function getPlannerClaudeToolVisibilityEnv(
  name: string,
  defaultValue: ClaudeToolVisibility,
): ClaudeToolVisibility {
  const value = process.env[name]?.trim() || defaultValue;
  if (value === "restricted" || value === "legacyAllowedToolsOnly") {
    return value;
  }

  throw new Error(
    `Invalid Claude tool visibility for ${name}: ${process.env[name]}. ` +
      "Expected one of: restricted, legacyAllowedToolsOnly.",
  );
}

function getPlannerClaudeToolGuardEnv(
  name: string,
  defaultValue: ClaudeToolGuard,
): ClaudeToolGuard {
  const value = process.env[name]?.trim() || defaultValue;
  if (value === "enabled" || value === "disabledWhenRestricted") {
    return value;
  }

  throw new Error(
    `Invalid Claude tool guard for ${name}: ${process.env[name]}. ` +
      "Expected one of: enabled, disabledWhenRestricted.",
  );
}

function getOptionalPositiveIntegerEnv(name: string): number | undefined {
  const rawValue = process.env[name]?.trim();
  if (!rawValue) {
    return undefined;
  }

  const parsed = parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid positive integer for ${name}: ${process.env[name]}`,
    );
  }
  return parsed;
}

function getPositiveIntegerEnv(name: string, defaultValue: number): number {
  const parsed = getOptionalPositiveIntegerEnv(name);
  return parsed ?? defaultValue;
}

function getSdkTraceModeEnv(
  name: string,
  defaultValue: SdkTraceMode,
): SdkTraceMode {
  const value = process.env[name]?.trim() || defaultValue;
  if (value === "off" || value === "failure" || value === "always") {
    return value;
  }

  throw new Error(
    `Invalid SDK trace mode for ${name}: ${process.env[name]}. ` +
      "Expected one of: off, failure, always.",
  );
}

function getSdkStallThinkingPreviewEnv(
  name: string,
  defaultValue: SdkStallThinkingPreview,
): SdkStallThinkingPreview {
  const value = process.env[name]?.trim() || defaultValue;
  if (value === "off" || value === "tail") {
    return value;
  }

  throw new Error(
    `Invalid SDK stall thinking preview for ${name}: ${process.env[name]}. ` +
      "Expected one of: off, tail.",
  );
}

function getReviewerProviderEnv(name: string): "openai" | "anthropic" {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) {
    return "openai";
  }
  if (value === "openai" || value === "anthropic") {
    return value;
  }
  throw new Error(
    `Invalid reviewer provider for ${name}: ${process.env[name]}. ` +
      "Expected one of: openai, anthropic.",
  );
}

function getQueueUrlFromConfig(
  config: OneShotQueueConfig,
  stage: OneShotQueueStage,
): string {
  switch (stage) {
    case "planning":
      return config.planningQueueUrl;
    case "review":
      return config.reviewQueueUrl;
    case "implementation":
      return config.implementationQueueUrl;
    case "code_review":
      return config.codeReviewQueueUrl;
    case "testing":
      return config.testingQueueUrl;
  }
}

export function getOneShotSharedConfig(): OneShotSharedConfig {
  const artifactBucket =
    process.env[ONE_SHOT_ARTIFACT_BUCKET_ENV]?.trim() ||
    `${process.env.S3_BUCKET_PREFIX || "specter"}-results`;
  const repoBasePath =
    process.env.REPOSITORY_PATH ||
    process.env.EFS_MOUNT_PATH ||
    "/mnt/efs/specter-repo/repositories";
  const repoAdminBasePath =
    process.env.ONESHOT_REPO_ADMIN_BASE?.trim() ||
    process.env.REPO_ADMIN_PATH?.trim() ||
    repoBasePath;
  const workspaceBasePath =
    process.env.ONESHOT_WORKSPACE_BASE || "/mnt/efs/specter-repo/oneshot";
  const repoCacheBasePath =
    process.env.ONESHOT_REPO_CACHE_BASE?.trim() ||
    path.join(workspaceBasePath, "repos");
  const worktreeBasePath =
    process.env.ONESHOT_WORKTREE_BASE?.trim() || workspaceBasePath;

  const rawPromptSource = process.env.ONESHOT_PROMPT_SOURCE?.trim() || "local";
  if (rawPromptSource !== "s3" && rawPromptSource !== "local") {
    throw new Error(
      `Invalid ONESHOT_PROMPT_SOURCE="${rawPromptSource}". Must be "s3" or "local".`,
    );
  }
  const promptSource: PromptSource = rawPromptSource;
  const promptManifestVersionId =
    process.env.ONESHOT_PROMPT_MANIFEST_VERSION_ID?.trim() || undefined;

  if (promptSource === "s3" && !promptManifestVersionId) {
    throw new Error(
      "ONESHOT_PROMPT_MANIFEST_VERSION_ID is required when ONESHOT_PROMPT_SOURCE=s3",
    );
  }

  const reviewerEnabled = getBooleanEnv(ONE_SHOT_REVIEWER_ENABLED_ENV, true);
  const codeReviewerEnabled = getBooleanEnv(
    ONE_SHOT_CODE_REVIEWER_ENABLED_ENV,
    true,
  );
  const verifyModeRaw =
    process.env[ONE_SHOT_VERIFY_MODE_ENV]?.trim().toLowerCase() || "balanced";
  const verifyMode =
    verifyModeRaw === "strict" || verifyModeRaw === "lenient"
      ? verifyModeRaw
      : "balanced";
  const reviewerProvider = getReviewerProviderEnv(
    ONE_SHOT_REVIEWER_PROVIDER_ENV,
  );
  const reviewerModelId =
    process.env[ONE_SHOT_REVIEWER_MODEL_ID_ENV]?.trim() || undefined;
  if (reviewerProvider === "anthropic" && !reviewerModelId) {
    throw new Error(
      `Refusing to start: ${ONE_SHOT_REVIEWER_PROVIDER_ENV}=anthropic requires ${ONE_SHOT_REVIEWER_MODEL_ID_ENV} to be set (e.g., "us.anthropic.claude-opus-4-6-v1").`,
    );
  }
  const codeReviewerProvider = getReviewerProviderEnv(
    ONE_SHOT_CODE_REVIEWER_PROVIDER_ENV,
  );
  const codeReviewerModelId =
    process.env[ONE_SHOT_CODE_REVIEWER_MODEL_ID_ENV]?.trim() || undefined;
  if (codeReviewerProvider === "anthropic" && !codeReviewerModelId) {
    throw new Error(
      `Refusing to start: ${ONE_SHOT_CODE_REVIEWER_PROVIDER_ENV}=anthropic requires ${ONE_SHOT_CODE_REVIEWER_MODEL_ID_ENV} to be set (e.g., "us.anthropic.claude-opus-4-6-v1").`,
    );
  }
  const reviewStagesBlockOnExhaustion = getBooleanEnv(
    ONE_SHOT_REVIEW_STAGES_BLOCK_ON_EXHAUSTION_ENV,
    false,
  );
  const plannerModelId =
    process.env[ONE_SHOT_PLANNER_MODEL_ID_ENV]?.trim() || undefined;
  const plannerMaxOutputTokens = parseInt(
    process.env[ONE_SHOT_PLANNER_MAX_OUTPUT_TOKENS_ENV] || "100000",
    10,
  );
  const plannerMaxThinkingTokens = getOptionalPositiveIntegerEnv(
    ONE_SHOT_PLANNER_MAX_THINKING_TOKENS_ENV,
  );
  const plannerMaxRepoToolCalls = getPositiveIntegerEnv(
    ONE_SHOT_PLANNER_MAX_REPO_TOOL_CALLS_ENV,
    18,
  );
  const plannerMaxTurns = getPositiveIntegerEnv(
    ONE_SHOT_PLANNER_MAX_TURNS_ENV,
    40,
  );
  const implementerMaxOutputTokens = parseInt(
    process.env[ONE_SHOT_IMPLEMENTER_MAX_OUTPUT_TOKENS_ENV] || "100000",
    10,
  );
  const implementerModelId =
    process.env[ONE_SHOT_IMPLEMENTER_MODEL_ID_ENV]?.trim() ||
    DEFAULT_IMPLEMENTER_MODEL_ID;
  // Prod default 180 — 50% headroom over the original hardcoded 120, without
  // writing a blank check. Local override pushes to 500 for debugging.
  const implementerMaxTurns = getPositiveIntegerEnv(
    ONE_SHOT_IMPLEMENTER_MAX_TURNS_ENV,
    180,
  );
  // Code-reviewer structured-output JSON easily exceeds 4096 on real-sized
  // PRs. Default 50000 matches the local retry that succeeded on CPDEV-21561;
  // output tokens bill only what's used, so a generous cap is free when idle.
  const codeReviewerMaxOutputTokens = getPositiveIntegerEnv(
    ONE_SHOT_CODE_REVIEWER_MAX_OUTPUT_TOKENS_ENV,
    50_000,
  );
  const plannerClaudePermissionMode = getPlannerClaudePermissionModeEnv(
    ONE_SHOT_PLANNER_CLAUDE_PERMISSION_MODE_ENV,
    "default",
  );
  const plannerClaudeToolVisibility = getPlannerClaudeToolVisibilityEnv(
    ONE_SHOT_PLANNER_CLAUDE_TOOL_VISIBILITY_ENV,
    "restricted",
  );
  const plannerClaudeToolGuard = getPlannerClaudeToolGuardEnv(
    ONE_SHOT_PLANNER_CLAUDE_TOOL_GUARD_ENV,
    "enabled",
  );
  const plannerToolSprawlGuard = getBooleanEnv(
    ONE_SHOT_PLANNER_TOOL_SPRAWL_GUARD_ENV,
    true,
  );
  const plannerSkillsEnabled = getBooleanEnv(
    ONE_SHOT_PLANNER_SKILLS_ENABLED_ENV,
    true,
  );
  const plannerSubagentsEnabled = getBooleanEnv(
    ONE_SHOT_PLANNER_SUBAGENTS_ENABLED_ENV,
    true,
  );
  const plannerSubagentMaxTurns = getPositiveIntegerEnv(
    ONE_SHOT_PLANNER_SUBAGENT_MAX_TURNS_ENV,
    16,
  );
  const plannerPluginPath = resolveOneShotPlannerPluginPath(
    process.env[ONE_SHOT_PLANNER_PLUGIN_PATH_ENV]?.trim() ||
      DEFAULT_ONESHOT_PLANNER_PLUGIN_PATH,
  );
  const plannerScoutEnabled = getBooleanEnv(
    ONE_SHOT_PLANNER_SCOUT_ENABLED_ENV,
    true,
  );
  const configWarnings: string[] = [];
  const rawPlannerScoutModelId =
    process.env[ONE_SHOT_PLANNER_SCOUT_MODEL_ID_ENV]?.trim() ||
    DEFAULT_PLANNER_SCOUT_MODEL_ID;
  const plannerScoutModelId =
    rawPlannerScoutModelId === LEGACY_PLANNER_SCOUT_MODEL_ID
      ? DEFAULT_PLANNER_SCOUT_MODEL_ID
      : rawPlannerScoutModelId;
  if (rawPlannerScoutModelId === LEGACY_PLANNER_SCOUT_MODEL_ID) {
    configWarnings.push(LEGACY_PLANNER_SCOUT_MODEL_WARNING);
  }
  const sdkTraceMode = getSdkTraceModeEnv(
    ONE_SHOT_SDK_TRACE_MODE_ENV,
    "failure",
  );
  const sdkStallThinkingPreview = getSdkStallThinkingPreviewEnv(
    ONE_SHOT_SDK_STALL_THINKING_PREVIEW_ENV,
    "off",
  );
  const reviewerBypassReason =
    process.env[ONE_SHOT_REVIEWER_BYPASS_REASON_ENV]?.trim() || undefined;
  const codeReviewerBypassReason =
    process.env[ONE_SHOT_CODE_REVIEWER_BYPASS_REASON_ENV]?.trim() || undefined;
  const commentAssetBaseUrl =
    process.env[ONE_SHOT_COMMENT_ASSET_BASE_URL_ENV]?.trim() || undefined;
  const dashboardBaseUrl =
    process.env[ONE_SHOT_DASHBOARD_BASE_URL_ENV]?.trim() || undefined;

  if (
    !reviewerEnabled &&
    process.env.NODE_ENV === "production" &&
    !reviewerBypassReason
  ) {
    throw new Error(
      `Refusing to start: ONESHOT_REVIEWER_ENABLED=false in production requires ONESHOT_REVIEWER_BYPASS_REASON to be set (e.g., "TICKET-1234: disabled for load test until DATE").`,
    );
  }

  if (
    !codeReviewerEnabled &&
    process.env.NODE_ENV === "production" &&
    !codeReviewerBypassReason
  ) {
    throw new Error(
      `Refusing to start: ONESHOT_CODE_REVIEWER_ENABLED=false in production requires ONESHOT_CODE_REVIEWER_BYPASS_REASON to be set (e.g., "TICKET-1234: disabled for load test until DATE").`,
    );
  }

  if (process.env.NODE_ENV === "production" && !commentAssetBaseUrl) {
    throw new Error(
      `Refusing to start: ${ONE_SHOT_COMMENT_ASSET_BASE_URL_ENV} must be set in production so OneShot Jira comments can include the required logo image.`,
    );
  }

  if (process.env.NODE_ENV === "production" && !dashboardBaseUrl) {
    throw new Error(
      `Refusing to start: ${ONE_SHOT_DASHBOARD_BASE_URL_ENV} must be set in production so the first OneShot Jira comment can link to the dashboard pipeline.`,
    );
  }

  return {
    region: process.env.AWS_REGION || "us-east-2",
    artifactBucket,
    artifactPrefix:
      process.env[ONE_SHOT_ARTIFACT_PREFIX_ENV]?.trim() || "oneshot",
    maxReviewLoops: parseInt(
      process.env[ONE_SHOT_MAX_REVIEW_LOOPS_ENV] || "3",
      10,
    ),
    maxVerificationLoops: parseInt(
      process.env[ONE_SHOT_MAX_VERIFICATION_LOOPS_ENV] || "3",
      10,
    ),
    maxTotalTokens: parseInt(
      process.env[ONE_SHOT_MAX_TOTAL_TOKENS_ENV] || "50000000",
      10,
    ),
    maxStageTokens: {
      planning: parseInt(
        process.env[ONE_SHOT_MAX_STAGE_TOKENS_PLANNING_ENV] || "4000000",
        10,
      ),
      review: parseInt(
        process.env[ONE_SHOT_MAX_STAGE_TOKENS_REVIEW_ENV] || "2000000",
        10,
      ),
      implementation: parseInt(
        process.env[ONE_SHOT_MAX_STAGE_TOKENS_IMPLEMENTATION_ENV] || "4000000",
        10,
      ),
      code_review: parseInt(
        process.env[ONE_SHOT_MAX_STAGE_TOKENS_CODE_REVIEW_ENV] || "2000000",
        10,
      ),
      testing: parseInt(
        process.env[ONE_SHOT_MAX_STAGE_TOKENS_TESTING_ENV] || "2000000",
        10,
      ),
    },
    maxStageAttempts: parseInt(
      process.env[ONE_SHOT_MAX_STAGE_ATTEMPTS_ENV] || "5",
      10,
    ),
    reconcileStaleMinutes: parseInt(
      process.env[ONE_SHOT_RECONCILE_STALE_MINUTES_ENV] || "10",
      10,
    ),
    staleMinutesImplementation: parseInt(
      process.env[ONE_SHOT_STALE_MINUTES_IMPLEMENTATION_ENV] || "20",
      10,
    ),
    staleMinutesPlanning: parseInt(
      process.env[ONE_SHOT_STALE_MINUTES_PLANNING_ENV] || "45",
      10,
    ),
    staleMinutesTesting: parseInt(
      process.env[ONE_SHOT_STALE_MINUTES_TESTING_ENV] || "20",
      10,
    ),
    reviewerEnabled,
    codeReviewerEnabled,
    traceEnabled: getBooleanEnv(ONE_SHOT_TRACE_ENABLED_ENV, true),
    tracePostToJira: getBooleanEnv(ONE_SHOT_TRACE_POST_TO_JIRA_ENV, true),
    implementationPlanPostToJira: getBooleanEnv(
      ONE_SHOT_IMPLEMENTATION_PLAN_POST_TO_JIRA_ENV,
      true,
    ),
    verifyEnabled: getBooleanEnv(ONE_SHOT_VERIFY_ENABLED_ENV, true),
    verifyMode,
    reviewStagesBlockOnExhaustion,
    reviewerProvider,
    reviewerModelId,
    codeReviewerProvider,
    codeReviewerModelId,
    plannerModelId,
    plannerMaxOutputTokens,
    plannerMaxThinkingTokens,
    plannerMaxRepoToolCalls,
    plannerMaxTurns,
    implementerModelId,
    implementerMaxOutputTokens,
    implementerMaxTurns,
    codeReviewerMaxOutputTokens,
    plannerClaudePermissionMode,
    plannerClaudeToolVisibility,
    plannerClaudeToolGuard,
    plannerToolSprawlGuard,
    plannerSkillsEnabled,
    plannerSubagentsEnabled,
    plannerSubagentMaxTurns,
    plannerPluginPath,
    plannerScoutEnabled,
    plannerScoutModelId,
    ...(configWarnings.length > 0 ? { configWarnings } : {}),
    sdkTraceMode,
    sdkStallThinkingPreview,
    reviewerBypassReason,
    codeReviewerBypassReason,
    repoBasePath,
    repoAdminBasePath,
    repoCacheBasePath,
    workspaceBasePath,
    worktreeBasePath,
    mavenBuildsEnabled: getBooleanEnv(ONE_SHOT_MAVEN_BUILDS_ENABLED_ENV, true),
    workspaceLeaseTtlSeconds: parseInt(
      process.env.ONESHOT_WORKSPACE_LEASE_TTL_SECONDS || "2700",
      10,
    ),
    workspaceLeaseHeartbeatSeconds: parseInt(
      process.env.ONESHOT_WORKSPACE_LEASE_HEARTBEAT_SECONDS || "30",
      10,
    ),
    retrofitRepoCacheLeaseWaitMs: getPositiveIntegerEnv(
      ONE_SHOT_RETROFIT_REPO_CACHE_LEASE_WAIT_MS_ENV,
      300_000,
    ),
    repoCacheFreshnessTtlMs: parseInt(
      process.env.ONESHOT_REPO_CACHE_FRESHNESS_TTL_MS || "300000",
      10,
    ),
    promptSource,
    promptBucket: process.env.ONESHOT_PROMPT_BUCKET?.trim() || artifactBucket,
    promptManifestKey:
      process.env.ONESHOT_PROMPT_MANIFEST_KEY?.trim() ||
      "oneshot/manifest.json",
    promptManifestVersionId,
    promptCacheTtlMs: parseInt(
      process.env.ONESHOT_PROMPT_CACHE_TTL_MS || "60000",
      10,
    ),
    healthcareGuardrailsEnabled:
      process.env.ONESHOT_HEALTHCARE_GUARDRAILS === "true",
    promptLocalPath:
      process.env.ONESHOT_PROMPT_LOCAL_PATH?.trim() || "oneshot-prompts",
    commentAssetBaseUrl,
    dashboardBaseUrl,
  };
}

export function getOneShotQueueConfig(): OneShotQueueConfig {
  return {
    ...getOneShotSharedConfig(),
    role: process.env.ONESHOT_ROLE
      ? OneShotRoleSchema.parse(process.env.ONESHOT_ROLE)
      : undefined,
    planningQueueUrl: getRequiredEnv(ONE_SHOT_PLANNING_QUEUE_ENV),
    reviewQueueUrl: getRequiredEnv(ONE_SHOT_REVIEW_QUEUE_ENV),
    implementationQueueUrl: getRequiredEnv(ONE_SHOT_IMPLEMENTATION_QUEUE_ENV),
    codeReviewQueueUrl: getRequiredEnv(ONE_SHOT_CODE_REVIEW_QUEUE_ENV),
    testingQueueUrl: getRequiredEnv(ONE_SHOT_TESTING_QUEUE_ENV),
  };
}

export function getOneShotConsumerConfig(): OneShotConsumerConfig {
  const config = getOneShotQueueConfig();
  if (!config.role) {
    throw new Error("ONESHOT_ROLE is required for queue-consumer runtime");
  }

  return config as OneShotConsumerConfig;
}

export function getQueueUrl(
  config: OneShotQueueConfig,
  stage: OneShotQueueStage,
): string {
  return getQueueUrlFromConfig(config, stage);
}

export function buildOneShotArtifactKey(
  config: Pick<OneShotSharedConfig, "artifactPrefix">,
  jiraKey: string,
  runId: number,
  stage:
    | "qualification"
    | "plan"
    | "trace"
    | "verify"
    | "review"
    | "implementation"
    | "code_review"
    | "test_result",
  version: number,
): string {
  const prefix = config.artifactPrefix;

  switch (stage) {
    case "qualification":
      return `${prefix}/${jiraKey}/run-${runId}/qualification/v${version}/qualification.json`;
    case "plan":
      return `${prefix}/${jiraKey}/run-${runId}/plans/v${version}/plan.json`;
    case "trace":
      return `${prefix}/${jiraKey}/run-${runId}/trace/v${version}/test-cases.json`;
    case "verify":
      return `${prefix}/${jiraKey}/run-${runId}/verify/v${version}/verify-report.json`;
    case "review":
      return `${prefix}/${jiraKey}/run-${runId}/reviews/v${version}/review.json`;
    case "implementation":
      return `${prefix}/${jiraKey}/run-${runId}/implementation/v${version}/implementation.json`;
    case "code_review":
      return `${prefix}/${jiraKey}/run-${runId}/code-reviews/v${version}/code-review.json`;
    case "test_result":
      return `${prefix}/${jiraKey}/run-${runId}/test-results/v${version}/test-result.json`;
  }
}

export function buildOneShotReviewArtifactKey(
  config: Pick<OneShotSharedConfig, "artifactPrefix">,
  jiraKey: string,
  runId: number,
  planVersion: number,
  reviewRound: number,
): string {
  return `${config.artifactPrefix}/${jiraKey}/run-${runId}/reviews/v${planVersion}-r${reviewRound}/review.json`;
}

export function buildOneShotVerificationOnlyCompletionArtifactKey(
  config: Pick<OneShotSharedConfig, "artifactPrefix">,
  jiraKey: string,
  runId: number,
  planVersion: number,
): string {
  return `${config.artifactPrefix}/${jiraKey}/run-${runId}/verification-only/v${planVersion}/completion.json`;
}
