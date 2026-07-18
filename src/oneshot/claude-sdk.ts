import { query as latestQuery } from "@specter/oneshot-claude-agent-sdk";
import { createRequire } from "module";
import {
  parseJsonFromTextWithRepair,
  parseJsonWithRepair,
  parseValidatedJsonFromTextWithRepair,
  registerRepoFromPath,
  runAgent as runAgentWithDefaultSdk,
  type AgentResult,
  type AgentRunnerOptions,
  type BedrockConfig,
  type ClaudeAgentSdkBinding,
  type ClaudePermissionMode,
  type ClaudeToolBudgetGuard,
  type ClaudeToolGuard,
  type ClaudeToolVisibility,
  type SdkLifecycleSummary,
  type SdkStallThinkingPreview,
  type SdkTraceMode,
} from "../claude-sdk/index.js";
import {
  validateClaudeExecutable,
  type ClaudeExecutableValidationResult,
  type ValidateClaudeExecutableOptions,
} from "../claude-sdk/claudeExecutable.js";

export const ONESHOT_CLAUDE_AGENT_SDK_SOURCE_ENV =
  "ONESHOT_CLAUDE_AGENT_SDK_SOURCE";
export const ONESHOT_CLAUDE_AGENT_SDK_ALIAS =
  "@specter/oneshot-claude-agent-sdk";
export const ONESHOT_CLAUDE_AGENT_SDK_VERSION = "0.3.183";

export type OneShotClaudeAgentSdkSource = "latest" | "legacy";

const requireFromThisModule = createRequire(import.meta.url);

function resolveOneShotSdkPackageBinary(
  specifier: string,
): string | undefined {
  try {
    const aliasEntry = requireFromThisModule.resolve(
      ONESHOT_CLAUDE_AGENT_SDK_ALIAS,
    );
    return createRequire(aliasEntry).resolve(specifier);
  } catch {
    return undefined;
  }
}

function getOneShotClaudeAgentSdkSource(
  env: Record<string, string | undefined> = process.env,
): OneShotClaudeAgentSdkSource {
  return env[ONESHOT_CLAUDE_AGENT_SDK_SOURCE_ENV] === "legacy"
    ? "legacy"
    : "latest";
}

const latestOneShotSdkBinding: ClaudeAgentSdkBinding = {
  query: latestQuery as unknown as ClaudeAgentSdkBinding["query"],
  resolvePackageBinary: resolveOneShotSdkPackageBinary,
  sdkSource: "oneshot_latest",
  sdkPackageName: ONESHOT_CLAUDE_AGENT_SDK_ALIAS,
  sdkPackageVersion: ONESHOT_CLAUDE_AGENT_SDK_VERSION,
};

export async function runAgent(
  options: AgentRunnerOptions,
): Promise<AgentResult> {
  if (getOneShotClaudeAgentSdkSource(options.env) === "legacy") {
    return runAgentWithDefaultSdk(options);
  }

  return runAgentWithDefaultSdk({
    ...options,
    sdkBinding: latestOneShotSdkBinding,
  });
}

export async function validateOneShotClaudeExecutable(
  options: ValidateClaudeExecutableOptions = {},
): Promise<ClaudeExecutableValidationResult> {
  if (getOneShotClaudeAgentSdkSource(options.env) === "legacy") {
    return validateClaudeExecutable(options);
  }

  return validateClaudeExecutable({
    ...options,
    resolvePackageBinary:
      options.resolvePackageBinary ?? resolveOneShotSdkPackageBinary,
  });
}

export {
  parseJsonFromTextWithRepair,
  parseJsonWithRepair,
  parseValidatedJsonFromTextWithRepair,
  registerRepoFromPath,
};

export type {
  AgentResult,
  AgentRunnerOptions,
  BedrockConfig,
  ClaudeExecutableValidationResult,
  ClaudePermissionMode,
  ClaudeToolBudgetGuard,
  ClaudeToolGuard,
  ClaudeToolVisibility,
  SdkLifecycleSummary,
  SdkStallThinkingPreview,
  SdkTraceMode,
};
