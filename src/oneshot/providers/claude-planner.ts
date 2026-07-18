import {
  parseValidatedJsonFromTextWithRepair,
  registerRepoFromPath,
  runAgent,
  type AgentRunnerOptions,
  type BedrockConfig,
  type ClaudePermissionMode,
  type ClaudeToolBudgetGuard,
  type ClaudeToolGuard,
  type ClaudeToolVisibility,
  type SdkLifecycleSummary,
  type SdkStallThinkingPreview,
  type SdkTraceMode,
} from "../claude-sdk.js";
import { createLogger } from "../../utils/logger.js";
import type { PromptComposer } from "../prompt-composer.js";
import {
  getPlanImpactedFiles,
  mergePlannerDiscoverySanitizationReports,
  ONE_SHOT_PLAN_OUTPUT_SCHEMA,
  parseOneShotPlan,
  plannerDiscoverySanitizationTruncatedChars,
  plannerDiscoveriesWereSanitized,
  parseRetrofitAlreadyAppliedEvidence,
  repairOneShotStructuredPlanOutput,
  sanitizePlannerDiscoveries,
  type OneShotPlan,
  type PlannerDiscoverySanitizationReport,
  type PlannerStructuredOutputRepairReport,
} from "../schema/plan.js";
import {
  buildRetrofitExecutionContractFromEvidence,
  parseRetrofitExecutionContract,
  type RetrofitExecutionContractV1,
  type RetrofitFileChangeContractEntryForExecution,
} from "../retrofit-execution-contract.js";
import {
  PlannerRetrofitAlreadyAppliedError,
  type PlannerRetrofitContext,
} from "../retrofit-context.js";
import {
  formatRetrofitSourceEvidenceForPrompt,
  type RetrofitSourceEvidence,
} from "../retrofit-source-evidence.js";
import {
  buildRetrofitWorkflowSection,
  isRetrofitWorkflowRequired,
} from "../retrofit-workflow.js";
import {
  applyGroundingToPlan,
  formatPlannerEvidenceForPrompt,
  isRecoverableSourceRationaleSupport,
  isPlannerEvidenceStrong,
  isPlannerGroundingStrong,
  PlannerGroundingValidationError,
  type PlannerTargetValidationDecision,
  type PlannerGroundingValidationResult,
  validatePlanAgainstGrounding,
  type PlannerEvidenceContext,
  type PlannerGroundingContext,
} from "../planner-grounding.js";
import { mergeModelUsage, type OneShotModelUsage } from "../model-usage.js";
import {
  mergeModelCostUsage,
  type OneShotModelCostUsage,
} from "../model-cost-usage.js";
import type { OneShotProcessingMode } from "../processing-mode.js";
import {
  ONESHOT_PLANNER_PLUGIN_SKILLS,
  resolveOneShotPlannerPluginPath,
} from "../planner-plugin.js";
import * as fs from "fs";
import * as path from "path";
import { ZodError } from "zod";

const logger = createLogger("oneshot-planner");
const GROUNDING_REPAIR_MAX_FILES = 12;
const GROUNDING_REPAIR_MAX_BYTES_PER_FILE = 12_000;
const GROUNDING_REPAIR_MAX_TOTAL_BYTES = 80_000;
const GROUNDING_REPAIR_MAX_PATCH_EVIDENCE = 12;
const GROUNDING_REPAIR_MAX_PATCH_ALLOWED_CHANGES = 12;
const ONE_SHOT_GROUNDING_REPAIR_PATCH_OUTPUT_SCHEMA = {
  type: "object" as const,
  additionalProperties: true,
  properties: {
    rationale: { type: "string" as const, maxLength: 3000 },
    patches: {
      type: "array" as const,
      maxItems: GROUNDING_REPAIR_MAX_FILES,
      items: {
        type: "object" as const,
        additionalProperties: true,
        properties: {
          targetFile: { type: "string" as const, minLength: 1, maxLength: 500 },
          role: {
            type: "string" as const,
            enum: [
              "runtime_required",
              "test_required",
              "config_required",
              "source_parity",
            ],
          },
          rationale: { type: "string" as const, maxLength: 3000 },
          supportingEvidence: {
            type: "array" as const,
            maxItems: GROUNDING_REPAIR_MAX_PATCH_EVIDENCE,
            items: { type: "string" as const, minLength: 1, maxLength: 1000 },
          },
          allowedChanges: {
            type: "array" as const,
            maxItems: GROUNDING_REPAIR_MAX_PATCH_ALLOWED_CHANGES,
            items: { type: "string" as const, minLength: 1, maxLength: 1000 },
          },
          plannedCodeChangeRationale: {
            type: "string" as const,
            maxLength: 3000,
          },
        },
        required: ["targetFile"],
      },
    },
  },
  required: ["patches"],
};
const PLANNER_READ_TOOLS = ["Read", "Glob", "Grep"];
const RETROFIT_PLANNER_TOOLS = [...PLANNER_READ_TOOLS, "Bash"];
const PLANNER_AGENT_TOOL = "Agent";
const PLANNER_SKILL_TOOL = "Skill";
const PLANNER_NESTED_AGENT_TOOLS = [PLANNER_AGENT_TOOL, "Task"];
const PLANNER_NESTED_AGENT_TOOL_SET = new Set<string>(
  PLANNER_NESTED_AGENT_TOOLS,
);
const PLANNER_SUBAGENT_EXCLUDED_TOOL_SET = new Set<string>([
  ...PLANNER_NESTED_AGENT_TOOLS,
  PLANNER_SKILL_TOOL,
]);
const PLANNER_REPOSITORY_PROGRESS_TOOLS = new Set<string>(PLANNER_READ_TOOLS);
const PLANNER_RETROFIT_REPOSITORY_PROGRESS_TOOLS = new Set<string>([
  ...PLANNER_READ_TOOLS,
  "Bash",
]);
const PLANNER_SUBAGENT_ATTEMPT_MISSING_WARNING =
  "planner_subagent_attempt_missing";
const DEFAULT_PLANNER_SUBAGENT_MAX_TURNS = 16;
const DEFAULT_PLANNER_SUBAGENT_MODEL_ID =
  "us.anthropic.claude-haiku-4-5-20251001-v1:0";
export type PlannerSubagentOutcome =
  | "configured_not_attempted"
  | "attempted_failed_or_denied"
  | "attempted_succeeded";
const GIT_REF_PATTERN = "origin/[A-Za-z0-9._/-]+";
const GIT_SHA_PATTERN = "[A-Fa-f0-9]{7,40}";
const GIT_PATH_PATTERN = "[A-Za-z0-9._/@:+,-]+";
const GIT_PATHSPEC_PATTERN = "(?:\\s+--(?:\\s+" + GIT_PATH_PATTERN + ")*)?";
const GIT_GREP_PATTERN = "(?:'[^';&`<>]*'|\"[^\";&`$<>]*\"|[^\\s;&|`$<>]+)";
const GIT_LOG_OPTIONS_PATTERN =
  "(?:(?:--format=(?:fuller|oneline|medium|short)|--regexp-ignore-case|--extended-regexp|--merges|--no-merges|--reverse)\\s+)*";
const GIT_DIFF_OPTIONS_PATTERN =
  "(?:(?:--name-status|--stat|--patch)\\s+){0,3}";
interface RetrofitBashCommandSpec {
  pattern: string;
  examples: (
    context: PlannerRetrofitContext,
    exactJiraKeyPattern: string,
  ) => string[];
}

const RETROFIT_BASH_COMMANDS: RetrofitBashCommandSpec[] = [
  {
    pattern: "^git\\s+rev-parse\\s+--verify\\s+" + GIT_REF_PATTERN + "$",
    examples: (context) => [
      `git rev-parse --verify origin/${context.sourceBranch}`,
      `git rev-parse --verify origin/${context.targetBranch}`,
    ],
  },
  {
    pattern:
      "^git\\s+merge-base\\s+" +
      GIT_REF_PATTERN +
      "\\s+" +
      GIT_REF_PATTERN +
      "$",
    examples: (context) => [
      `git merge-base origin/${context.targetBranch} origin/${context.sourceBranch}`,
    ],
  },
  {
    pattern:
      "^git\\s+log\\s+" +
      GIT_LOG_OPTIONS_PATTERN +
      "(?:--grep=" +
      GIT_GREP_PATTERN +
      "\\s+)?" +
      GIT_REF_PATTERN +
      "\\.\\." +
      GIT_REF_PATTERN +
      GIT_PATHSPEC_PATTERN +
      "$",
    examples: (context, exactJiraKeyPattern) => [
      `git log --format=fuller --regexp-ignore-case --extended-regexp --reverse --no-merges --grep='${exactJiraKeyPattern}' origin/${context.targetBranch}..origin/${context.sourceBranch}`,
      `git log --format=fuller --regexp-ignore-case --extended-regexp --reverse --merges --grep='${exactJiraKeyPattern}' origin/${context.targetBranch}..origin/${context.sourceBranch}`,
    ],
  },
  {
    pattern:
      "^git\\s+cherry\\s+-v\\s+" +
      GIT_REF_PATTERN +
      "\\s+" +
      GIT_REF_PATTERN +
      "$",
    examples: (context) => [
      `git cherry -v origin/${context.targetBranch} origin/${context.sourceBranch}`,
    ],
  },
  {
    pattern:
      "^git\\s+show\\s+" +
      GIT_DIFF_OPTIONS_PATTERN +
      GIT_SHA_PATTERN +
      GIT_PATHSPEC_PATTERN +
      "$",
    examples: () => ["git show --stat --name-status --patch <matched-sha>"],
  },
  {
    pattern:
      "^git\\s+diff\\s+" +
      GIT_DIFF_OPTIONS_PATTERN +
      GIT_REF_PATTERN +
      "(?:\\.\\.\\.|\\.\\.)" +
      GIT_REF_PATTERN +
      GIT_PATHSPEC_PATTERN +
      "$",
    examples: (context) => [
      `git diff --name-status --stat --patch origin/${context.targetBranch}...origin/${context.sourceBranch} -- <relevant-paths>`,
    ],
  },
  {
    pattern: "^git\\s+cat-file\\s+(?:-e|-t)\\s+" + GIT_SHA_PATTERN + "$",
    examples: () => ["git cat-file -t <matched-sha>"],
  },
];
const RETROFIT_BASH_ALLOWLIST_PATTERNS = RETROFIT_BASH_COMMANDS.map(
  (command) => command.pattern,
);

export interface PlannerToolPolicy {
  retrofitContextPresent: boolean;
  allowedTools: readonly string[];
  allowedBashCommandPatterns?: readonly string[];
}

export function validatePlannerToolPolicy(policy: PlannerToolPolicy): void {
  if (!policy.retrofitContextPresent && policy.allowedTools.includes("Bash")) {
    throw new Error(
      "planner_bash_allowlist_missing: Non-retrofit planner requests must not enable Bash.",
    );
  }
  if (
    policy.retrofitContextPresent &&
    policy.allowedTools.includes("Bash") &&
    (!policy.allowedBashCommandPatterns ||
      policy.allowedBashCommandPatterns.length === 0)
  ) {
    throw new Error(
      "planner_bash_allowlist_missing: Retrofit planner Bash requires an explicit command allowlist.",
    );
  }
}

validatePlannerToolPolicy({
  retrofitContextPresent: false,
  allowedTools: PLANNER_READ_TOOLS,
});
validatePlannerToolPolicy({
  retrofitContextPresent: true,
  allowedTools: RETROFIT_PLANNER_TOOLS,
  allowedBashCommandPatterns: RETROFIT_BASH_ALLOWLIST_PATTERNS,
});

function plannerSkillsEnabled(request: PlannerRequest): boolean {
  return request.plannerSkillsEnabled ?? true;
}

function plannerSubagentsEnabled(request: PlannerRequest): boolean {
  return request.plannerSubagentsEnabled ?? true;
}

function buildPlannerAllowedTools(request: PlannerRequest): string[] {
  const baseTools = request.retrofitContext
    ? RETROFIT_PLANNER_TOOLS
    : PLANNER_READ_TOOLS;
  const skillTools = plannerSkillsEnabled(request) ? [PLANNER_SKILL_TOOL] : [];
  if (!plannerSubagentsEnabled(request)) {
    return [...baseTools, ...skillTools];
  }
  return [...baseTools, ...skillTools, PLANNER_AGENT_TOOL];
}

function resolvePlannerPluginPath(pluginPath?: string): string {
  return resolveOneShotPlannerPluginPath(pluginPath);
}

function buildPlannerSkillOptions(
  request: PlannerRequest,
): Pick<AgentRunnerOptions, "plugins" | "skills"> {
  if (!plannerSkillsEnabled(request)) {
    return {};
  }
  return {
    plugins: [
      {
        type: "local",
        path: resolvePlannerPluginPath(request.plannerPluginPath),
      },
    ],
    skills: [...ONESHOT_PLANNER_PLUGIN_SKILLS],
  };
}

function plannerSubagentTools(parentAllowedTools: readonly string[]): string[] {
  return parentAllowedTools.filter(
    (toolName) => !PLANNER_SUBAGENT_EXCLUDED_TOOL_SET.has(toolName),
  );
}

function buildPlannerSubagentOptions(
  request: PlannerRequest,
  parentAllowedTools: readonly string[],
): Pick<AgentRunnerOptions, "agents"> {
  if (!plannerSubagentsEnabled(request)) {
    return {};
  }
  const tools = plannerSubagentTools(parentAllowedTools);
  const model =
    request.plannerSubagentModelId?.trim() || DEFAULT_PLANNER_SUBAGENT_MODEL_ID;
  const maxTurns =
    request.plannerSubagentMaxTurns ?? DEFAULT_PLANNER_SUBAGENT_MAX_TURNS;
  const commonAgentConfig = {
    tools,
    disallowedTools: [...PLANNER_NESTED_AGENT_TOOLS],
    model,
    maxTurns,
  };
  return {
    agents: {
      "oneshot-grounding-scout": {
        ...commonAgentConfig,
        description:
          "Inspect a small set of repository files and return evidence that grounds a OneShot implementation plan.",
        prompt:
          "You are a OneShot planner grounding scout. Use only the allowed repository tools to verify candidate files, key symbols, and nearby tests. Return concise evidence with file paths and uncertainty; do not write files or produce an implementation plan.",
      },
      "oneshot-decomposition-scout": {
        ...commonAgentConfig,
        description:
          "Assess whether a OneShot ticket should remain one same-repo plan or be logically decomposed into slices.",
        prompt:
          "You are a OneShot logical-decomposition scout. Inspect repository structure only as needed, then identify same-repo logical slices, dependencies, and shared-test risks. Keep the work in one worktree and one final PR.",
      },
      "oneshot-domain-scout": {
        ...commonAgentConfig,
        description:
          "Look for MedHOK/core-app domain cues that make the OneShot planner more specific.",
        prompt:
          "You are a MedHOK domain planning scout. Use existing prompt and repository evidence only. Identify relevant module, SmartGWT, service, workflow, configuration, or test patterns that should shape the plan, and avoid unsupported domain claims.",
      },
    },
  };
}

function buildPlannerNativeSubagentInstruction(request: PlannerRequest): string {
  if (!plannerSubagentsEnabled(request)) {
    return "";
  }
  return [
    "## Native Planner Subagents",
    "",
    "Your first Agent scout attempt is required when native subagents are enabled.",
    "The first tool call should be `Agent` with `subagent_type: \"oneshot-grounding-scout\"`; ask it to verify one narrow grounded detail, not rediscover the repository broadly.",
    "Use at most one or two focused scout calls before writing the final plan. Do not use nested Agent or Task calls.",
    "Scout success is not required; the final structured OneShot plan is required.",
    "If an Agent scout errors, exhausts its turn budget, times out, or returns incomplete evidence, continue with deterministic grounding and direct repository tools, then record any uncertainty in risks or open questions.",
    "Available scouts: oneshot-grounding-scout, oneshot-decomposition-scout, oneshot-domain-scout.",
  ].join("\n");
}

function buildPlannerSkillChecklistInstruction(request: PlannerRequest): string {
  if (!plannerSkillsEnabled(request)) {
    return "";
  }
  return [
    "## Planner Skill Checklist",
    "",
    "Apply this checklist before final JSON; explicit Skill tool invocation is optional.",
    "- planner-scouting: if native subagents are enabled, attempt the required `oneshot-grounding-scout` first, with at most two scout calls total and fallback-to-plan on scout failure.",
    "- planner-grounding: cite exact inspected files, keep file discovery evidence-backed, and record uncertainty rather than inventing paths.",
    "- logical-decomposition: keep same-repo logical slices in one worktree, one plan, and one final PR.",
    "- medhok-domain-planning: use MedHOK/core-app guidance only when ticket evidence and inspected repo evidence support it.",
    "- plan-quality-gate: include exact target files, PRISM-style file roles/code sketches, validation commands, guardrail decisions, and no placeholders.",
    "- test-first-validation-planning: prefer failing-test-first coverage when a real test surface exists; otherwise document evidence-backed manual checks and coverage gaps.",
    "- root-cause-investigation-planning: for bug/failure tickets, plan reproduce/trace/compare evidence before proposing fix files.",
  ].join("\n");
}

// NOTE: PLANNER_OUTPUT_CONTRACT_APPENDIX was removed. All constraints it
// carried are now in oneshot-prompts/prompts/plan-system.md under Planning
// Methodology #3 (including the "user-visible evidence summary, not hidden
// chain-of-thought" phrasing and the "adjacent same-package or same-pattern
// file" rule). Keeping them in one place reduces duplication-driven
// inconsistency and prevents the repetition pattern that inverse-scaling
// research shows reduces LLM compliance.

function normalizeToolPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

function isSafeRelativeToolPath(value: string): boolean {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  return (
    Boolean(normalized) &&
    !/^(?:[a-zA-Z]:)?\//.test(normalized) &&
    !normalized.split("/").some((part) => part === "..")
  );
}

function toWorkspaceRelativePath(
  filePath: string,
  workspacePath: string,
): string | undefined {
  const normalizedFilePath = normalizeToolPath(filePath);
  const workspaceRoots = [normalizeToolPath(workspacePath)];
  try {
    workspaceRoots.push(normalizeToolPath(fs.realpathSync(workspacePath)));
  } catch {
    // Best-effort only; workspacePath itself is still used.
  }
  for (const root of [...workspaceRoots]) {
    if (root.startsWith("/tmp/")) {
      workspaceRoots.push(`/private${root}`);
    } else if (root.startsWith("/private/tmp/")) {
      workspaceRoots.push(root.replace(/^\/private/, ""));
    }
  }

  for (const root of Array.from(new Set(workspaceRoots))) {
    if (normalizedFilePath === root) {
      return undefined;
    }
    if (normalizedFilePath.startsWith(`${root}/`)) {
      const relative = normalizedFilePath.slice(root.length + 1);
      return isSafeRelativeToolPath(relative) ? relative : undefined;
    }
  }

  const relative = normalizedFilePath.replace(/^\.\//, "");
  return isSafeRelativeToolPath(relative) ? relative : undefined;
}

function finalPlannerReadFilesFromMetrics(
  metrics: PlannerAttemptMetrics,
  workspacePath: string,
): string[] {
  const readFiles = (metrics.toolCallProfiles ?? [])
    .filter(
      (profile) =>
        profile.tool === "Read" && profile.success && profile.filePath,
    )
    .map((profile) => toWorkspaceRelativePath(profile.filePath!, workspacePath))
    .filter((file): file is string => Boolean(file));
  return Array.from(new Set(readFiles));
}

function finalPlannerDiscoveredFilesFromMetrics(
  metrics: PlannerAttemptMetrics,
  workspacePath: string,
): string[] {
  const discoveredFiles = (metrics.toolCallProfiles ?? [])
    .filter((profile) => profile.tool === "Glob" && profile.success)
    .flatMap((profile) => profile.filenames ?? [])
    .map((file) => toWorkspaceRelativePath(file, workspacePath))
    .filter((file): file is string => Boolean(file));
  return Array.from(new Set(discoveredFiles));
}

function groundedFileSet(request: PlannerRequest): Set<string> {
  const files = [
    ...(request.groundingContext?.candidateFiles.map((file) => file.path) ??
      []),
    ...(request.groundingContext?.snippets.map((snippet) => snippet.file) ??
      []),
    ...(request.groundingContext?.riskFiles ?? []),
    ...(request.evidenceContext?.scoutReports.flatMap(
      (report) => report.verifiedInspectedFiles,
    ) ?? []),
  ].map((file) => normalizeToolPath(file));
  return new Set(files);
}

function toolSearchFingerprint(
  profile: NonNullable<PlannerAttemptMetrics["toolCallProfiles"]>[number],
): string | null {
  if (profile.tool !== "Glob" && profile.tool !== "Grep") {
    return null;
  }
  return [
    profile.tool,
    (profile.searchPath ?? "").toLowerCase(),
    (profile.directory ?? "").toLowerCase(),
    (profile.pattern ?? "").toLowerCase(),
  ].join(":");
}

function isBroadSearchProfile(
  profile: NonNullable<PlannerAttemptMetrics["toolCallProfiles"]>[number],
): boolean {
  const pattern = (profile.pattern ?? "").trim().toLowerCase();
  if (!pattern) {
    return false;
  }
  if (profile.tool === "Glob") {
    const directory = (profile.directory ?? "").trim();
    const rootScoped = !directory || directory === "." || directory === "./";
    return (
      rootScoped &&
      (pattern === "**/*" ||
        pattern === "**/*.*" ||
        /^(\*\*\/)?\*\.\{?[a-z0-9,]+\}?$/i.test(pattern) ||
        /^\*\*\/\*\.?\{?[a-z0-9,]+\}?$/i.test(pattern))
    );
  }
  if (profile.tool === "Grep") {
    const searchPath = (profile.searchPath ?? "").trim();
    const rootScoped = !searchPath || searchPath === "." || searchPath === "./";
    const shortPattern = pattern.replace(/\\b|\W/g, "").length <= 3;
    return rootScoped && shortPattern;
  }
  return false;
}

function plannerToolLoopMetrics(
  metrics: PlannerAttemptMetrics,
  request: PlannerRequest,
): Pick<
  PlannerAttemptMetrics,
  | "readCalls"
  | "grepCalls"
  | "globCalls"
  | "effectiveReads"
  | "groundingOverlap"
  | "searchCallRatio"
  | "repeatedSearchGlobCount"
  | "broadSearchCount"
> {
  const profiles = metrics.toolCallProfiles ?? [];
  const readProfiles = profiles.filter((profile) => profile.tool === "Read");
  const grepProfiles = profiles.filter((profile) => profile.tool === "Grep");
  const globProfiles = profiles.filter((profile) => profile.tool === "Glob");
  const readFiles = new Set(
    readProfiles
      .filter((profile) => profile.success && profile.filePath)
      .map((profile) =>
        toWorkspaceRelativePath(profile.filePath!, request.workspacePath),
      )
      .filter((file): file is string => Boolean(file))
      .map((file) => normalizeToolPath(file)),
  );
  const groundedFiles = groundedFileSet(request);
  const groundingOverlap = Array.from(readFiles).filter((file) =>
    groundedFiles.has(file),
  ).length;
  const searchFingerprints = new Map<string, number>();
  for (const profile of [...grepProfiles, ...globProfiles]) {
    const fingerprint = toolSearchFingerprint(profile);
    if (!fingerprint) continue;
    searchFingerprints.set(
      fingerprint,
      (searchFingerprints.get(fingerprint) ?? 0) + 1,
    );
  }
  const repeatedSearchGlobCount = Array.from(
    searchFingerprints.values(),
  ).reduce((sum, count) => sum + Math.max(0, count - 1), 0);

  return {
    readCalls: readProfiles.length,
    grepCalls: grepProfiles.length,
    globCalls: globProfiles.length,
    effectiveReads: readFiles.size,
    groundingOverlap,
    searchCallRatio:
      readProfiles.length === 0
        ? grepProfiles.length + globProfiles.length
        : Number(
            (
              (grepProfiles.length + globProfiles.length) /
              readProfiles.length
            ).toFixed(3),
          ),
    repeatedSearchGlobCount,
    broadSearchCount: [...grepProfiles, ...globProfiles].filter(
      isBroadSearchProfile,
    ).length,
  };
}

function plannerSubagentOutcome(
  metrics: PlannerAttemptMetrics,
): PlannerSubagentOutcome {
  const lifecycle = metrics.sdkLifecycleSummary;
  if (
    (lifecycle?.subagentStartCount ?? 0) > 0 ||
    (lifecycle?.taskStartedCount ?? 0) > 0
  ) {
    return "attempted_succeeded";
  }
  const agentProfiles = (metrics.toolCallProfiles ?? []).filter((profile) =>
    PLANNER_NESTED_AGENT_TOOL_SET.has(profile.tool),
  );
  if (agentProfiles.some((profile) => profile.success)) {
    return "attempted_succeeded";
  }
  if (agentProfiles.length > 0) {
    return "attempted_failed_or_denied";
  }
  const permissionDenials = lifecycle?.permissionDenials ?? [];
  const deniedAgent = permissionDenials.some((denial) => {
    if (!denial || typeof denial !== "object") {
      return false;
    }
    const record = denial as Record<string, unknown>;
    const toolName = record.toolName ?? record.tool_name;
    return typeof toolName === "string" && PLANNER_NESTED_AGENT_TOOL_SET.has(toolName);
  });
  return deniedAgent ? "attempted_failed_or_denied" : "configured_not_attempted";
}

function plannerRepositoryProgressToolCalls(
  metrics: PlannerAttemptMetrics | undefined,
  request: PlannerRequest,
): number {
  if (!metrics) {
    return 0;
  }
  const profiles = metrics.toolCallProfiles;
  if (!profiles || profiles.length === 0) {
    return metrics.toolCalls ?? 0;
  }
  const progressTools = request.retrofitContext
    ? PLANNER_RETROFIT_REPOSITORY_PROGRESS_TOOLS
    : PLANNER_REPOSITORY_PROGRESS_TOOLS;
  return profiles.filter((profile) => {
    if (!progressTools.has(profile.tool)) {
      return false;
    }
    if (profile.tool === "Read") {
      return Boolean(
        profile.filePath &&
          toWorkspaceRelativePath(profile.filePath, request.workspacePath),
      );
    }
    if (profile.tool === "Grep") {
      const searchPath = profile.searchPath;
      if (!searchPath || searchPath === "." || searchPath === "./") {
        return true;
      }
      return Boolean(toWorkspaceRelativePath(searchPath, request.workspacePath));
    }
    if (profile.tool === "Glob") {
      const directory = profile.directory;
      if (!directory || directory === "." || directory === "./") {
        return true;
      }
      return Boolean(toWorkspaceRelativePath(directory, request.workspacePath));
    }
    return true;
  }).length;
}

function recordPlannerSubagentAttemptMetrics(
  metrics: PlannerAttemptMetrics,
  request: PlannerRequest,
): void {
  if (!plannerSubagentsEnabled(request)) {
    return;
  }
  const outcome = plannerSubagentOutcome(metrics);
  const attempted = outcome !== "configured_not_attempted";
  metrics.plannerSubagentOutcome = outcome;
  metrics.plannerSubagentAttempted = attempted;
  metrics.plannerSubagentAttemptMissing = !attempted;
  if (attempted) {
    return;
  }
  metrics.warnings = [
    ...(metrics.warnings ?? []),
    PLANNER_SUBAGENT_ATTEMPT_MISSING_WARNING,
  ];
  logger.warn(
    {
      jiraKey: request.jiraKey,
      repoName: request.repoName,
    },
    "Planner native subagents were enabled but no Agent scout attempt was observed",
  );
}

function combinePlannerSubagentOutcome(
  primary?: PlannerSubagentOutcome,
  secondary?: PlannerSubagentOutcome,
): PlannerSubagentOutcome | undefined {
  if (primary === "attempted_succeeded" || secondary === "attempted_succeeded") {
    return "attempted_succeeded";
  }
  if (
    primary === "attempted_failed_or_denied" ||
    secondary === "attempted_failed_or_denied"
  ) {
    return "attempted_failed_or_denied";
  }
  if (
    primary === "configured_not_attempted" ||
    secondary === "configured_not_attempted"
  ) {
    return "configured_not_attempted";
  }
  return undefined;
}

export interface PlannerAttemptMetrics {
  durationMs: number;
  toolCalls: number;
  tokensUsed?: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  costUsd?: number;
  costUsdExact?: boolean;
  modelUsed?: string;
  modelUsage?: OneShotModelUsage;
  modelCostUsage?: OneShotModelCostUsage;
  llmToolCalls?: number;
  groundingCandidateFiles?: number;
  groundingConfidence?: PlannerGroundingContext["confidence"];
  groundingSource?: "deterministic" | "llm_tools" | "mixed" | "scouts";
  plannerScoutStatus?: PlannerEvidenceContext["scoutStatus"];
  scoutReports?: number;
  scoutCoverage?: PlannerEvidenceContext["scoutCoverage"];
  plannerSubagentAttempted?: boolean;
  plannerSubagentAttemptMissing?: boolean;
  plannerSubagentOutcome?: PlannerSubagentOutcome;
  scoutInvocationFailed?: boolean;
  scoutReturnedNothing?: boolean;
  proceededWithWeakScout?: boolean;
  warnings?: string[];
  readCalls?: number;
  grepCalls?: number;
  globCalls?: number;
  effectiveReads?: number;
  groundingOverlap?: number;
  searchCallRatio?: number;
  repeatedSearchGlobCount?: number;
  broadSearchCount?: number;
  plannerOutputSanitized?: boolean;
  plannerOutputTruncatedChars?: number;
  plannerOutputSanitization?: PlannerDiscoverySanitizationReport;
  plannerRetrofitPlanNormalization?: RetrofitPlanNormalizationReport;
  plannerStructuredOutputRepair?: PlannerStructuredOutputRepairReport;
  sdkLifecycleSummary?: SdkLifecycleSummary;
  sdkRawTrace?: unknown[];
  plannerSourceRecoveryAccepted?: number;
  plannerSourceRecoveryRejected?: number;
  plannerSourceRecoveryCandidates?: number;
  plannerGroundingRepairAttempted?: boolean;
  plannerGroundingRepairAccepted?: boolean;
  plannerGroundingRepairRejected?: boolean;
  plannerGroundingRepairMode?: "patch" | "full_plan" | "full_plan_fallback";
  plannerGroundingRepairRejectedTargetCount?: number;
  plannerGroundingRepairTargetFiles?: string[];
  plannerGroundingRepairReadFiles?: string[];
  plannerGroundingRepairError?: string;
  toolCallProfiles?: Array<{
    tool: string;
    durationMs: number;
    inputBytes: number;
    outputBytes: number;
    success: boolean;
    command?: string;
    exitCode?: number;
    filePath?: string;
    searchPath?: string;
    pattern?: string;
    directory?: string;
    filenames?: string[];
  }>;
}

interface SourceRationaleRecoveryResult {
  validation: PlannerGroundingValidationResult;
  recoveredFiles: string[];
  acceptedTargets: number;
  rejectedTargets: number;
}

interface GroundingRepairSnippet {
  targetFile: string;
  content: string;
  truncated: boolean;
  bytes: number;
}

interface GroundingRepairPatch {
  targetFile: string;
  role?: "runtime_required" | "test_required" | "config_required" | "source_parity";
  rationale?: string;
  supportingEvidence?: string[];
  allowedChanges?: string[];
  plannedCodeChangeRationale?: string;
}

interface GroundingRepairPatchOutput {
  rationale?: string;
  patches: GroundingRepairPatch[];
}

interface GroundingRepairResult {
  attempted: boolean;
  accepted: boolean;
  mode?: "patch" | "full_plan" | "full_plan_fallback";
  rejectedTargetCount?: number;
  targetFiles: string[];
  readFiles: string[];
  plan?: OneShotPlan;
  validation?: PlannerGroundingValidationResult;
  finalPlannerReadFiles?: string[];
  finalPlannerDiscoveredFiles?: string[];
  metrics?: PlannerAttemptMetrics;
  rawOutput?: string;
  structuredOutput?: unknown;
  error?: string;
}

export interface PlannerStallDetails {
  metrics?: PlannerAttemptMetrics;
  modelUsed?: string;
  hasStructuredOutput?: boolean;
  groundingConfidence?: PlannerGroundingContext["confidence"];
  groundingCandidateFiles?: number;
  plannerScoutStatus?: PlannerEvidenceContext["scoutStatus"];
  outputPreview?: string;
  rawOutput?: string;
  structuredOutput?: unknown;
  draftPlan?: OneShotPlan;
  groundingValidation?: PlannerGroundingValidationResult;
  finalPlannerReadFiles?: string[];
  finalPlannerDiscoveredFiles?: string[];
  groundingEvidence?: {
    routeCards: PlannerGroundingContext["routeCards"];
    candidateFiles: Array<
      Pick<
        PlannerGroundingContext["candidateFiles"][number],
        "path" | "score" | "reasons" | "matchedTerms"
      >
    >;
    ticketExplicitNewSourceCandidates?: PlannerGroundingContext["ticketExplicitNewSourceCandidates"];
    riskFiles: string[];
    scoutStatus?: PlannerEvidenceContext["scoutStatus"];
    scoutReports?: Array<{
      workItemId: string;
      status: PlannerEvidenceContext["scoutReports"][number]["status"];
      verifiedInspectedFiles: string[];
      symbols: string[];
      testFiles: string[];
      commands: string[];
      blockers: string[];
      confidence: PlannerEvidenceContext["scoutReports"][number]["confidence"];
    }>;
  };
  structuredOutputRepair?: PlannerStructuredOutputRepairReport;
  retrofitPlanNormalization?: RetrofitPlanNormalizationReport;
  schemaValidationErrors?: PlannerSchemaValidationIssue[];
  schemaValidationStage?: PlannerSchemaValidationIssue["stage"];
}

export interface PlannerErrorWithAttemptDetails extends Error {
  plannerAttemptDetails?: PlannerStallDetails;
}

/**
 * Typed error for planner failures with classification for retry logic
 */
export class PlannerStallError extends Error {
  constructor(
    message: string,
    public readonly failureKind:
      | "idle_timeout"
      | "no_progress"
      | "wall_timeout"
      | "tool_stall"
      | "post_tool_idle_timeout"
      | "schema_invalid_after_success"
      | "retrofit_contract_missing_after_normalization"
      | "structured_output_retries_exhausted"
      | "other",
    public readonly details: PlannerStallDetails = {},
  ) {
    super(message);
    this.name = "PlannerStallError";
  }
}

export interface PlannerRevisionContext {
  previousPlan?: OneShotPlan;
  previousReview?: Record<string, unknown> | null;
  contractViolationContext?: {
    implementationVersion: number | null;
    revision: boolean | null;
    currentPlanVersion: number | null;
    nextPlanVersion: number | null;
    editableFiles: string[];
    changedFiles: string[];
    violatingFiles: string[];
    autoReplanAttempt: number | null;
    autoReplanMaxAttempts: number | null;
  };
  retrofitPatchConflictContext?: {
    implementationVersion: number | null;
    revision: boolean | null;
    currentPlanVersion: number | null;
    nextPlanVersion: number | null;
    sourceJiraKey: string | null;
    sourceBranch: string | null;
    targetBranch: string | null;
    selectedShas: string[];
    allowedFiles: string[];
    changedFiles: string[];
    violations: string[];
    recoverySubtype?: string | null;
    perCommitStatus: Array<{
      sha: string;
      subject?: string | null;
      status: string;
      sourceFiles: string[];
      targetFiles: string[];
      adaptationFiles: string[];
      conflictDiagnostics?: string | null;
      proofSnippets: string[];
      validationEvidence: string[];
      rationale?: string | null;
    }>;
    autoReplanAttempt: number | null;
    autoReplanMaxAttempts: number | null;
  };
}

export interface PlannerAttemptOverrides {
  timeoutMs?: number;
  idleTimeoutMs?: number;
  postToolIdleTimeoutMs?: number;
  useOutputSchema?: boolean;
  maxTurns?: number;
  bedrockConfig?: Partial<BedrockConfig>;
  permissionMode?: ClaudePermissionMode;
  toolVisibility?: ClaudeToolVisibility;
  toolGuard?: ClaudeToolGuard;
  toolSprawlGuard?: boolean;
  toolBudgetGuard?: ClaudeToolBudgetGuard;
  sdkTraceMode?: SdkTraceMode;
  sdkStallThinkingPreview?: SdkStallThinkingPreview;
}

export interface PlannerRequest {
  jiraKey: string;
  repoName: string;
  branchName: string;
  baseCommitSha: string;
  workspacePath: string;
  additionalDirectories?: string[];
  ticketSummary: string;
  taskDescription: string;
  processingMode?: OneShotProcessingMode;
  qualificationSummary: {
    requirementsSummary: string[];
    acceptanceCriteriaPresent: boolean;
    nonBlockingWarnings: string[];
  };
  revision: boolean;
  revisionContext?: PlannerRevisionContext;
  repoScanSummary?: string;
  routeCardContext?: string;
  groundingContext?: PlannerGroundingContext;
  groundingSummary?: string;
  evidenceContext?: PlannerEvidenceContext;
  evidenceSummary?: string;
  retrofitContext?: PlannerRetrofitContext;
  retrofitSourceEvidence?: RetrofitSourceEvidence;
  /** Additional scope section injected at the top of the prompt (e.g. multi-repo child brief). */
  additionalScopeSection?: string;
  plannerSkillsEnabled?: boolean;
  plannerSubagentsEnabled?: boolean;
  plannerPluginPath?: string;
  plannerSubagentModelId?: string;
  plannerSubagentMaxTurns?: number;
  attemptOverrides?: PlannerAttemptOverrides;
}

export interface PlannerResponse {
  plan: OneShotPlan;
  rawOutput: string;
  metrics: PlannerAttemptMetrics;
}

type PlannerMetrics = PlannerResponse["metrics"];

const OUTPUT_PREVIEW_LIMIT = 2_000;

export interface RetrofitPlanNormalizationReport {
  seededRetrofitEvidence: boolean;
  seededRetrofitExecutionContract: boolean;
  normalizedOptionalFields: string[];
  mergedModelContract: boolean;
  source: "none" | "qualification" | "model" | "qualification_and_model";
  missingAfterNormalization?: boolean;
}

export interface PlannerSchemaValidationIssue {
  path: string;
  message: string;
  code: string;
  stage: "initial_parse" | "repair_parse";
}

function emptyRetrofitPlanNormalizationReport(): RetrofitPlanNormalizationReport {
  return {
    seededRetrofitEvidence: false,
    seededRetrofitExecutionContract: false,
    normalizedOptionalFields: [],
    mergedModelContract: false,
    source: "none",
  };
}

function schemaValidationIssuesFromError(
  error: unknown,
  stage: PlannerSchemaValidationIssue["stage"],
): PlannerSchemaValidationIssue[] {
  if (!(error instanceof ZodError)) {
    return [];
  }
  return error.issues.slice(0, 20).map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
    code: issue.code,
    stage,
  }));
}

function outputPreview(output?: string): string | undefined {
  if (!output) {
    return undefined;
  }
  return output.length > OUTPUT_PREVIEW_LIMIT
    ? `${output.slice(0, OUTPUT_PREVIEW_LIMIT)}…`
    : output;
}

function recordPlannerSanitizationMetrics(
  metrics: PlannerMetrics,
  report: PlannerDiscoverySanitizationReport,
): void {
  if (!plannerDiscoveriesWereSanitized(report)) {
    return;
  }

  const truncatedChars = plannerDiscoverySanitizationTruncatedChars(report);
  metrics.plannerOutputSanitized = true;
  metrics.plannerOutputTruncatedChars = truncatedChars;
  metrics.plannerOutputSanitization = report;
  metrics.warnings = [
    ...(metrics.warnings ?? []),
    `planner_output_sanitized:${truncatedChars}:truncated_chars`,
  ];
}

function hasRetrofitPlanNormalization(report?: RetrofitPlanNormalizationReport): boolean {
  return Boolean(
    report &&
      (report.seededRetrofitEvidence ||
        report.seededRetrofitExecutionContract ||
        report.mergedModelContract ||
        report.normalizedOptionalFields.length > 0 ||
        report.missingAfterNormalization),
  );
}

function recordRetrofitPlanNormalizationMetrics(
  metrics: PlannerMetrics,
  report?: RetrofitPlanNormalizationReport,
): void {
  if (!hasRetrofitPlanNormalization(report)) {
    return;
  }
  metrics.plannerRetrofitPlanNormalization = report;
  const warnings = new Set(metrics.warnings ?? []);
  if (report?.seededRetrofitEvidence || report?.seededRetrofitExecutionContract) {
    warnings.add("retrofit_contract_seeded");
  }
  if (report?.mergedModelContract) {
    warnings.add("retrofit_contract_merged");
  }
  if (report?.normalizedOptionalFields.length) {
    warnings.add("retrofit_optional_fields_normalized");
  }
  if (report?.missingAfterNormalization) {
    warnings.add("retrofit_contract_missing_after_normalization");
  }
  metrics.warnings = Array.from(warnings);
}

function buildPlannerRetrofitEvidenceFromSource(
  evidence: RetrofitSourceEvidence,
): NonNullable<OneShotPlan["plannerDiscoveries"]>["retrofitEvidence"] {
  const sourcePrUrl = evidence.sourcePrUrl?.trim();
  return {
    sourceJiraKey: evidence.sourceJiraKey,
    sourceBranch: evidence.sourceBranch,
    targetBranch: evidence.targetBranch,
    ...(sourcePrUrl ? { sourcePrUrl } : {}),
    commitSelectionMethod: evidence.commitSelectionMethod,
    sourceCommitSelectionComplete: evidence.sourceCommitSelectionComplete,
    selectedCommits: evidence.selectedCommits.map((commit) => ({
      sha: commit.sha,
      subject: commit.subject,
      files: commit.files,
      alreadyApplied: commit.alreadyApplied === true,
    })),
    touchedFiles: evidence.touchedFiles,
    alreadyApplied:
      evidence.selectedCommits.length > 0 &&
      evidence.selectedCommits.every((commit) => commit.alreadyApplied === true),
    evidenceSummary: evidence.evidenceSummary,
  };
}

function nonEmptyList<T>(value: readonly T[] | undefined): readonly T[] {
  return value && value.length > 0 ? value : [];
}

function mergeRetrofitExecutionContracts(input: {
  seeded: RetrofitExecutionContractV1;
  model: RetrofitExecutionContractV1;
}): RetrofitExecutionContractV1 {
  const modelBySha = new Map(
    input.model.selectedCommits.map((commit) => [commit.sha.trim(), commit]),
  );
  const modelMappingsBySha = new Map(
    input.model.allowedFileMappings.map((mapping) => [
      mapping.sourceSha.trim(),
      mapping,
    ]),
  );

  return {
    ...input.seeded,
    sourceRepoName: input.seeded.sourceRepoName ?? input.model.sourceRepoName,
    sourceRepoUrl: input.seeded.sourceRepoUrl ?? input.model.sourceRepoUrl,
    sourcePrUrl: input.seeded.sourcePrUrl ?? input.model.sourcePrUrl,
    commitSelectionMethod: input.seeded.commitSelectionMethod,
    sourceCommitSelectionComplete: input.seeded.sourceCommitSelectionComplete,
    selectedCommits: input.seeded.selectedCommits.map((seededCommit) => {
      const modelCommit = modelBySha.get(seededCommit.sha.trim());
      if (!modelCommit) {
        return seededCommit;
      }
      return {
        ...seededCommit,
        subject: modelCommit.subject || seededCommit.subject,
        status: modelCommit.status ?? seededCommit.status,
        sourceFiles:
          nonEmptyList(modelCommit.sourceFiles).length > 0
            ? modelCommit.sourceFiles
            : seededCommit.sourceFiles,
        targetFiles:
          nonEmptyList(modelCommit.targetFiles).length > 0
            ? modelCommit.targetFiles
            : seededCommit.targetFiles,
        adaptationFiles:
          nonEmptyList(modelCommit.adaptationFiles).length > 0
            ? modelCommit.adaptationFiles
            : seededCommit.adaptationFiles,
        conflictDiagnostics:
          modelCommit.conflictDiagnostics ?? seededCommit.conflictDiagnostics,
        proofSnippets:
          nonEmptyList(modelCommit.proofSnippets).length > 0
            ? modelCommit.proofSnippets
            : seededCommit.proofSnippets,
        validationEvidence:
          nonEmptyList(modelCommit.validationEvidence).length > 0
            ? modelCommit.validationEvidence
            : seededCommit.validationEvidence,
        rationale: modelCommit.rationale ?? seededCommit.rationale,
      };
    }),
    allowedFileMappings: input.seeded.allowedFileMappings.map(
      (seededMapping) =>
        modelMappingsBySha.get(seededMapping.sourceSha.trim()) ??
        seededMapping,
    ),
  };
}

function normalizeRetrofitPlanFromQualification(input: {
  value: unknown;
  retrofitSourceEvidence?: RetrofitSourceEvidence;
  requireRetrofitContract: boolean;
  normalizationReport?: RetrofitPlanNormalizationReport;
}): { value: unknown; report: RetrofitPlanNormalizationReport } {
  const report =
    input.normalizationReport ?? emptyRetrofitPlanNormalizationReport();
  if (!input.value || typeof input.value !== "object" || Array.isArray(input.value)) {
    return { value: input.value, report };
  }

  const plan = { ...(input.value as Record<string, unknown>) };
  const rawDiscoveries = plan.plannerDiscoveries;
  const hadPlannerDiscoveries =
    Boolean(rawDiscoveries) &&
    typeof rawDiscoveries === "object" &&
    !Array.isArray(rawDiscoveries);
  const discoveries =
    hadPlannerDiscoveries
      ? { ...(rawDiscoveries as Record<string, unknown>) }
      : {};

  const hasModelEvidence = Boolean(discoveries.retrofitEvidence);
  const modelContract = parseRetrofitExecutionContract(
    discoveries.retrofitExecutionContract,
  );
  if (hasModelEvidence || modelContract) {
    report.source =
      input.retrofitSourceEvidence ? "qualification_and_model" : "model";
  }

  if (input.retrofitSourceEvidence) {
    const seededEvidence = buildPlannerRetrofitEvidenceFromSource(
      input.retrofitSourceEvidence,
    );
    if (!discoveries.retrofitEvidence) {
      discoveries.retrofitEvidence = seededEvidence;
      report.seededRetrofitEvidence = true;
    }

    const seededContract = buildRetrofitExecutionContractFromEvidence({
      evidence: input.retrofitSourceEvidence,
      fileChangeContract:
        Array.isArray(plan.fileChangeContract)
          ? (plan.fileChangeContract as RetrofitFileChangeContractEntryForExecution[])
          : [],
    });
    if (modelContract) {
      discoveries.retrofitExecutionContract = mergeRetrofitExecutionContracts({
        seeded: seededContract,
        model: modelContract,
      });
      report.mergedModelContract = true;
    } else if (!discoveries.retrofitExecutionContract) {
      discoveries.retrofitExecutionContract = seededContract;
      report.seededRetrofitExecutionContract = true;
    }
    report.source = hasModelEvidence || modelContract
      ? "qualification_and_model"
      : "qualification";
  }

  if (
    input.requireRetrofitContract &&
    !discoveries.retrofitEvidence &&
    !discoveries.retrofitExecutionContract
  ) {
    report.missingAfterNormalization = true;
  }

  const hasPlannerDiscoveries = Object.keys(discoveries).length > 0;
  return {
    value:
      hadPlannerDiscoveries || hasPlannerDiscoveries
        ? {
            ...plan,
            plannerDiscoveries: discoveries,
          }
        : plan,
    report,
  };
}

function plannerSourceRecoveryEnabled(): boolean {
  return (
    process.env.ONESHOT_PLANNER_SOURCE_RATIONALE_RECOVERY?.trim().toLowerCase() !==
    "false"
  );
}

function workspaceRelativeFileExists(
  workspacePath: string,
  relativePath: string,
): boolean {
  if (!isSafeRelativeToolPath(relativePath)) {
    return false;
  }
  const workspaceRoot = path.resolve(workspacePath);
  const absolutePath = path.resolve(workspaceRoot, relativePath);
  if (
    absolutePath !== workspaceRoot &&
    !absolutePath.startsWith(`${workspaceRoot}${path.sep}`)
  ) {
    return false;
  }
  try {
    return fs.statSync(absolutePath).isFile();
  } catch {
    return false;
  }
}

function workspaceRelativeAbsolutePath(
  workspacePath: string,
  relativePath: string,
): string | null {
  if (!isSafeRelativeToolPath(relativePath)) {
    return null;
  }
  const workspaceRoot = path.resolve(workspacePath);
  const absolutePath = path.resolve(workspaceRoot, relativePath);
  if (
    absolutePath !== workspaceRoot &&
    absolutePath.startsWith(`${workspaceRoot}${path.sep}`)
  ) {
    return absolutePath;
  }
  return null;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function groundingRepairEnabled(): boolean {
  return (
    process.env.ONESHOT_PLANNER_GROUNDING_REPAIR?.trim().toLowerCase() !==
    "false"
  );
}

function plannerGroundingRepairTargets(
  validation: PlannerGroundingValidationResult,
  workspacePath: string,
): string[] {
  const targets: string[] = [];
  for (const decision of validation.decisions) {
    if (decision.ok) {
      continue;
    }
    const targetFile = normalizeToolPath(decision.targetFile).replace(
      /^\.\//,
      "",
    );
    if (
      targetFile &&
      !targets.includes(targetFile) &&
      workspaceRelativeFileExists(workspacePath, targetFile)
    ) {
      targets.push(targetFile);
      if (targets.length >= GROUNDING_REPAIR_MAX_FILES) {
        break;
      }
    }
    for (const supportFile of decision.supportingFiles ?? []) {
      const normalizedSupport = normalizeToolPath(supportFile).replace(
        /^\.\//,
        "",
      );
      if (
        !normalizedSupport ||
        targets.includes(normalizedSupport) ||
        !workspaceRelativeFileExists(workspacePath, normalizedSupport)
      ) {
        continue;
      }
      targets.push(normalizedSupport);
      if (targets.length >= GROUNDING_REPAIR_MAX_FILES) {
        break;
      }
    }
    if (targets.length >= GROUNDING_REPAIR_MAX_FILES) {
      break;
    }
  }
  return targets;
}

function readGroundingRepairSnippets(
  workspacePath: string,
  targetFiles: readonly string[],
): GroundingRepairSnippet[] {
  const snippets: GroundingRepairSnippet[] = [];
  let totalBytes = 0;
  for (const targetFile of targetFiles) {
    const absolutePath = workspaceRelativeAbsolutePath(
      workspacePath,
      targetFile,
    );
    if (!absolutePath || totalBytes >= GROUNDING_REPAIR_MAX_TOTAL_BYTES) {
      continue;
    }
    try {
      const buffer = fs.readFileSync(absolutePath);
      const remainingBytes = Math.max(
        0,
        GROUNDING_REPAIR_MAX_TOTAL_BYTES - totalBytes,
      );
      const limit = Math.min(
        GROUNDING_REPAIR_MAX_BYTES_PER_FILE,
        remainingBytes,
      );
      if (limit <= 0) {
        break;
      }
      const content = buffer.subarray(0, limit).toString("utf8");
      const usedBytes = Math.min(buffer.byteLength, limit);
      snippets.push({
        targetFile,
        content,
        bytes: usedBytes,
        truncated: buffer.byteLength > limit,
      });
      totalBytes += usedBytes;
    } catch {
      // Ignore races/deleted files. The normal validation failure path remains.
    }
  }
  return snippets;
}

function validateRepairToolUse(
  metrics: PlannerAttemptMetrics,
  allowedFiles: readonly string[],
  workspacePath: string,
): string | null {
  const allowed = new Set(allowedFiles.map(normalizeToolPath));
  for (const profile of metrics.toolCallProfiles ?? []) {
    if (profile.tool === "StructuredOutput") {
      continue;
    }
    if (profile.tool !== "Read") {
      return `repair used disallowed ${profile.tool} tool`;
    }
    const filePath = profile.filePath
      ? toWorkspaceRelativePath(profile.filePath, workspacePath)
      : undefined;
    if (!filePath || !allowed.has(normalizeToolPath(filePath))) {
      return `repair read disallowed file ${profile.filePath ?? "<unknown>"}`;
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseJsonObjectFromOutput(output: string): unknown {
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? output;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("Grounding repair patch output did not contain JSON.");
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

function sanitizePatchStringList(
  value: unknown,
  maxItems: number,
): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const sanitized: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const trimmed = item.trim();
    if (!trimmed || sanitized.includes(trimmed)) {
      continue;
    }
    sanitized.push(trimmed);
    if (sanitized.length >= maxItems) {
      break;
    }
  }
  return sanitized;
}

function parseGroundingRepairPatchOutput(
  output: string | undefined,
  structuredOutput: unknown,
): GroundingRepairPatchOutput {
  const rawCandidate = isRecord(structuredOutput)
    ? structuredOutput
    : parseJsonObjectFromOutput(output ?? "");
  if (!isRecord(rawCandidate)) {
    throw new Error("Grounding repair patch output JSON was not an object.");
  }
  const candidate = rawCandidate;
  const patches = Array.isArray(candidate.patches) ? candidate.patches : [];
  return {
    ...(typeof candidate.rationale === "string" && candidate.rationale.trim()
      ? { rationale: candidate.rationale.trim().slice(0, 3000) }
      : {}),
    patches: patches
      .filter(isRecord)
      .map((patch) => {
        const targetFile =
          typeof patch.targetFile === "string"
            ? normalizeToolPath(patch.targetFile).replace(/^\.\//, "")
            : "";
        return {
          targetFile,
          ...(["runtime_required", "test_required", "config_required", "source_parity"].includes(
            typeof patch.role === "string" ? patch.role : "",
          )
            ? { role: patch.role as GroundingRepairPatch["role"] }
            : {}),
          ...(typeof patch.rationale === "string" && patch.rationale.trim()
            ? { rationale: patch.rationale.trim().slice(0, 3000) }
            : {}),
          supportingEvidence: sanitizePatchStringList(
            patch.supportingEvidence,
            GROUNDING_REPAIR_MAX_PATCH_EVIDENCE,
          ),
          allowedChanges: sanitizePatchStringList(
            patch.allowedChanges,
            GROUNDING_REPAIR_MAX_PATCH_ALLOWED_CHANGES,
          ),
          ...(typeof patch.plannedCodeChangeRationale === "string" &&
          patch.plannedCodeChangeRationale.trim()
            ? {
                plannedCodeChangeRationale:
                  patch.plannedCodeChangeRationale.trim().slice(0, 3000),
              }
            : {}),
        };
      })
      .filter((patch) => patch.targetFile && isSafeRelativeToolPath(patch.targetFile)),
  };
}

function plannerGroundingRejectedTargetFiles(
  validation: PlannerGroundingValidationResult,
): string[] {
  return uniqueStrings(
    validation.decisions
      .filter((decision) => !decision.ok)
      .map((decision) =>
        normalizeToolPath(decision.targetFile).replace(/^\.\//, ""),
      )
      .filter((targetFile) => targetFile && isSafeRelativeToolPath(targetFile)),
  );
}

function buildGroundingPatchRepairPrompt(input: {
  request: PlannerRequest;
  draftPlan: OneShotPlan;
  validation: PlannerGroundingValidationResult;
  rejectedTargetFiles: readonly string[];
  snippets: readonly GroundingRepairSnippet[];
}): string {
  const rejectedTargets = new Set(input.rejectedTargetFiles);
  const targetContext = input.rejectedTargetFiles.map((targetFile) => ({
    targetFile,
    specs: input.draftPlan.specs
      .filter((spec) => spec.targetFiles.includes(targetFile))
      .map((spec) => ({
        id: spec.id,
        objective: spec.objective,
        implementationNotes: spec.implementationNotes,
        validationSteps: spec.validationSteps,
        targetFileRationales: (spec.targetFileRationales ?? []).filter(
          (rationale) => rationale.targetFile === targetFile,
        ),
      })),
    fileChangeContract: (input.draftPlan.fileChangeContract ?? []).filter(
      (entry) => normalizeToolPath(entry.path).replace(/^\.\//, "") === targetFile,
    ),
    plannedCodeChanges: (input.draftPlan.plannedCodeChanges ?? []).filter(
      (change) =>
        normalizeToolPath(change.targetFile).replace(/^\.\//, "") === targetFile,
    ),
  }));
  const snippetText = input.snippets
    .map(
      (snippet) =>
        `### ${snippet.targetFile}\n` +
        `bytes=${snippet.bytes}${snippet.truncated ? " truncated=true" : ""}\n` +
        "```text\n" +
        snippet.content +
        "\n```",
    )
    .join("\n\n");
  const errors = input.validation.errors
    .filter((error) =>
      Array.from(rejectedTargets).some((targetFile) => error.includes(targetFile)),
    )
    .concat(
      input.validation.errors.filter(
        (error) =>
          !Array.from(rejectedTargets).some((targetFile) =>
            error.includes(targetFile),
          ),
      ),
    );
  return [
    "## OneShot Planner Grounding Patch Repair",
    "",
    "The draft plan failed deterministic target-file grounding. Return a small JSON patch only; do not re-emit the full OneShot plan.",
    "",
    "Patch rules:",
    "- Only patch the listed rejected target files.",
    "- Do not add new target files.",
    "- Prefer fixing fileChangeContract.rationale and fileChangeContract.supportingEvidence.",
    "- supportingEvidence must name exact adjacency-supporting files from the snippets or existing plan context.",
    "- If plannedCodeChanges for the same target need matching evidence/rationale, include it in the patch.",
    "- Do not use repository tools. All allowed repair evidence is included in this prompt.",
    "",
    "Return JSON with this shape:",
    "```json",
    JSON.stringify(
      {
        rationale: "why this patch is grounded",
        patches: [
          {
            targetFile: "path/to/rejected/file",
            role: "runtime_required",
            rationale:
              "fileChangeContract rationale referencing the exact supporting file",
            supportingEvidence: [
              "Exact supporting file path and concise evidence summary",
            ],
            allowedChanges: ["Narrow allowed implementation change"],
            plannedCodeChangeRationale:
              "optional rationale for existing plannedCodeChanges on this target",
          },
        ],
      },
      null,
      2,
    ),
    "```",
    "",
    `Jira: ${input.request.jiraKey}`,
    `Repo: ${input.request.repoName}`,
    `Base commit: ${input.request.baseCommitSha}`,
    "",
    "## Grounding Errors",
    errors.map((error) => `- ${error}`).join("\n") || "- none",
    "",
    "## Rejected Target Context",
    "```json",
    JSON.stringify(targetContext, null, 2),
    "```",
    "",
    "## Repair Evidence Snippets",
    snippetText || "No readable rejected target files were available.",
  ].join("\n");
}

function buildGroundingRepairPrompt(input: {
  request: PlannerRequest;
  draftPlan: OneShotPlan;
  validation: PlannerGroundingValidationResult;
  snippets: readonly GroundingRepairSnippet[];
}): string {
  const snippetText = input.snippets
    .map(
      (snippet) =>
        `### ${snippet.targetFile}\n` +
        `bytes=${snippet.bytes}${snippet.truncated ? " truncated=true" : ""}\n` +
        "```text\n" +
        snippet.content +
        "\n```",
    )
    .join("\n\n");
  return [
    "## OneShot Planner Grounding Repair",
    "",
    "The draft plan below failed deterministic target-file grounding. Repair the plan and return a complete OneShot plan JSON object that satisfies the output schema.",
    "",
    "Rules:",
    "- Keep strict grounding. Do not rely on Glob/file-name existence as edit evidence.",
    "- Use the exact file snippets below as the only new evidence.",
    "- Keep a target file only when the snippet or existing plan evidence supports the implementation notes for that file.",
    "- Remove unsupported target files and remove or adjust related implementation notes, validation steps, risks, assumptions, and open questions.",
    "- Do not add new target files that were not in the original draft plan.",
    "- Do not use repository tools. All allowed repair evidence is included in this prompt.",
    "",
    `Jira: ${input.request.jiraKey}`,
    `Repo: ${input.request.repoName}`,
    `Base commit: ${input.request.baseCommitSha}`,
    "",
    "## Grounding Errors",
    input.validation.errors.map((error) => `- ${error}`).join("\n") || "- none",
    "",
    "## Rejected Target File Evidence",
    snippetText || "No readable rejected target files were available.",
    "",
    "## Original Draft Plan JSON",
    "```json",
    JSON.stringify(input.draftPlan, null, 2),
    "```",
  ].join("\n");
}

function mergeBoundedStrings(
  existing: readonly string[],
  additions: readonly string[],
  maxItems: number,
): string[] {
  return uniqueStrings([
    ...existing.map((item) => item.trim()).filter(Boolean),
    ...additions.map((item) => item.trim()).filter(Boolean),
  ]).slice(0, maxItems);
}

function planReferencesTargetFile(plan: OneShotPlan, targetFile: string): boolean {
  return (
    plan.specs.some((spec) =>
      spec.targetFiles.some(
        (file) => normalizeToolPath(file).replace(/^\.\//, "") === targetFile,
      ),
    ) ||
    (plan.fileChangeContract ?? []).some(
      (entry) => normalizeToolPath(entry.path).replace(/^\.\//, "") === targetFile,
    ) ||
    (plan.plannedCodeChanges ?? []).some(
      (change) =>
        normalizeToolPath(change.targetFile).replace(/^\.\//, "") === targetFile,
    )
  );
}

function applyGroundingRepairPatchToPlan(
  draftPlan: OneShotPlan,
  patchOutput: GroundingRepairPatchOutput,
  rejectedTargetFiles: readonly string[],
): OneShotPlan {
  const rejectedTargets = new Set(rejectedTargetFiles);
  const patchedPlan = JSON.parse(JSON.stringify(draftPlan)) as OneShotPlan;

  for (const patch of patchOutput.patches) {
    const targetFile = normalizeToolPath(patch.targetFile).replace(/^\.\//, "");
    if (
      !rejectedTargets.has(targetFile) ||
      !planReferencesTargetFile(patchedPlan, targetFile)
    ) {
      continue;
    }

    const supportingEvidence = patch.supportingEvidence ?? [];
    const allowedChanges = patch.allowedChanges ?? [];
    const rationale = patch.rationale ?? patchOutput.rationale;

    let contract = (patchedPlan.fileChangeContract ?? []).find(
      (entry) =>
        normalizeToolPath(entry.path).replace(/^\.\//, "") === targetFile,
    );
    if (!contract) {
      contract = {
        path: targetFile,
        role: patch.role ?? "runtime_required",
        editable: true,
        rationale:
          rationale ??
          `Grounding repair supplied supporting evidence for ${targetFile}.`,
        supportingEvidence,
        allowedChanges,
      };
      patchedPlan.fileChangeContract = [
        ...(patchedPlan.fileChangeContract ?? []),
        contract,
      ];
    } else {
      if (patch.role) {
        contract.role = patch.role;
      }
      if (rationale) {
        contract.rationale = rationale;
      }
      contract.supportingEvidence = mergeBoundedStrings(
        contract.supportingEvidence ?? [],
        supportingEvidence,
        GROUNDING_REPAIR_MAX_PATCH_EVIDENCE,
      );
      contract.allowedChanges = mergeBoundedStrings(
        contract.allowedChanges ?? [],
        allowedChanges,
        GROUNDING_REPAIR_MAX_PATCH_ALLOWED_CHANGES,
      );
    }

    for (const spec of patchedPlan.specs) {
      for (const targetRationale of spec.targetFileRationales ?? []) {
        if (
          normalizeToolPath(targetRationale.targetFile).replace(/^\.\//, "") !==
          targetFile
        ) {
          continue;
        }
        if (rationale) {
          targetRationale.rationale = rationale;
        }
        targetRationale.supportingFiles = mergeBoundedStrings(
          targetRationale.supportingFiles ?? [],
          supportingEvidence,
          GROUNDING_REPAIR_MAX_PATCH_EVIDENCE,
        );
      }
    }

    for (const change of patchedPlan.plannedCodeChanges ?? []) {
      if (
        normalizeToolPath(change.targetFile).replace(/^\.\//, "") !== targetFile
      ) {
        continue;
      }
      const changeRationale = patch.plannedCodeChangeRationale ?? rationale;
      if (changeRationale) {
        change.rationale = changeRationale;
      }
      change.supportingEvidence = mergeBoundedStrings(
        change.supportingEvidence ?? [],
        supportingEvidence,
        GROUNDING_REPAIR_MAX_PATCH_EVIDENCE,
      );
    }
  }

  return patchedPlan;
}

function withRecoveryDiagnostics(
  baseValidation: PlannerGroundingValidationResult,
  recoveredValidation: PlannerGroundingValidationResult,
  recoveryRejectedDecisions: PlannerTargetValidationDecision[],
): PlannerGroundingValidationResult {
  return {
    ok: recoveredValidation.ok,
    errors: recoveredValidation.errors,
    warnings: uniqueStrings([
      ...baseValidation.warnings,
      ...recoveredValidation.warnings,
    ]),
    decisions: [
      ...baseValidation.decisions,
      ...recoveredValidation.decisions,
      ...recoveryRejectedDecisions,
    ],
  };
}

function sourceRecoveryRejectedDecision(
  decision: PlannerTargetValidationDecision,
  reason: string,
): PlannerTargetValidationDecision {
  return {
    rawTargetFile: decision.rawTargetFile,
    targetFile: decision.targetFile,
    kind: "source_recovery_rejected",
    ok: false,
    reason,
    ...(decision.recoveryCandidateFiles
      ? { recoveryCandidateFiles: decision.recoveryCandidateFiles }
      : {}),
    rationaleRequired: true,
    rationalePresent: decision.rationalePresent,
  };
}

function validatePlanWithSourceRationaleRecovery(
  plan: OneShotPlan,
  request: PlannerRequest,
  validationOptions: {
    finalPlannerReadFiles: string[];
    finalPlannerDiscoveredFiles: string[];
    allowAdjacentTestWithRationale: boolean;
  },
): SourceRationaleRecoveryResult {
  const baseValidation = validatePlanAgainstGrounding(
    plan,
    request.groundingContext,
    request.evidenceContext,
    validationOptions,
  );
  const candidates = baseValidation.decisions.filter(
    (decision) => decision.kind === "source_rationale_recovery_candidate",
  );
  if (
    baseValidation.ok ||
    candidates.length === 0 ||
    !plannerSourceRecoveryEnabled()
  ) {
    return {
      validation: baseValidation,
      recoveredFiles: [],
      acceptedTargets: 0,
      rejectedTargets: 0,
    };
  }

  const recoveredFiles = new Set<string>();
  const recoveryRejectedDecisions: PlannerTargetValidationDecision[] = [];
  for (const decision of candidates) {
    // Recovery is intentionally exact-path only: no globbing, basename search, or inferred support.
    const verifiedForTarget = (decision.recoveryCandidateFiles ?? [])
      .map((candidate) => normalizeToolPath(candidate).replace(/^\.\//, ""))
      .filter(
        (candidate) =>
          isRecoverableSourceRationaleSupport(decision.targetFile, candidate) &&
          workspaceRelativeFileExists(request.workspacePath, candidate),
      );
    for (const file of verifiedForTarget) {
      recoveredFiles.add(file);
    }
    if (verifiedForTarget.length === 0) {
      recoveryRejectedDecisions.push(
        sourceRecoveryRejectedDecision(
          decision,
          "no exact supportingFiles were verified as existing same-package source or mapping evidence",
        ),
      );
    }
  }

  if (recoveredFiles.size === 0) {
    return {
      validation: {
        ...baseValidation,
        decisions: [...baseValidation.decisions, ...recoveryRejectedDecisions],
      },
      recoveredFiles: [],
      acceptedTargets: 0,
      rejectedTargets: recoveryRejectedDecisions.length,
    };
  }

  const recoveredValidation = validatePlanAgainstGrounding(
    plan,
    request.groundingContext,
    request.evidenceContext,
    {
      ...validationOptions,
      recoveredSourceRationaleFiles: Array.from(recoveredFiles),
    },
  );
  const acceptedTargets = new Set(
    recoveredValidation.decisions
      .filter(
        (decision) =>
          decision.kind === "source_accepted_via_rationale_recovery" &&
          decision.ok,
      )
      .map((decision) => decision.targetFile),
  );
  const alreadyRejectedTargets = new Set(
    recoveryRejectedDecisions.map((decision) => decision.targetFile),
  );
  const rejectedAfterRecovery = candidates
    .filter(
      (decision) =>
        !acceptedTargets.has(decision.targetFile) &&
        !alreadyRejectedTargets.has(decision.targetFile),
    )
    .map((decision) =>
      sourceRecoveryRejectedDecision(
        decision,
        "exact supportingFiles did not satisfy source rationale recovery",
      ),
    );

  return {
    validation: withRecoveryDiagnostics(baseValidation, recoveredValidation, [
      ...recoveryRejectedDecisions,
      ...rejectedAfterRecovery,
    ]),
    recoveredFiles: Array.from(recoveredFiles),
    acceptedTargets: acceptedTargets.size,
    rejectedTargets:
      recoveryRejectedDecisions.length + rejectedAfterRecovery.length,
  };
}

function recordSourceRecoveryMetrics(
  metrics: PlannerMetrics,
  result: SourceRationaleRecoveryResult,
): void {
  if (
    result.acceptedTargets === 0 &&
    result.rejectedTargets === 0 &&
    result.recoveredFiles.length === 0
  ) {
    return;
  }
  metrics.plannerSourceRecoveryAccepted = result.acceptedTargets;
  metrics.plannerSourceRecoveryRejected = result.rejectedTargets;
  metrics.plannerSourceRecoveryCandidates = result.validation.decisions.filter(
    (decision) => decision.kind === "source_rationale_recovery_candidate",
  ).length;
  metrics.warnings = [
    ...(metrics.warnings ?? []),
    `planner_source_recovery:accepted:${result.acceptedTargets}:rejected:${result.rejectedTargets}`,
  ];
}

function recordGroundingRepairMetrics(
  metrics: PlannerMetrics,
  result: GroundingRepairResult,
): void {
  if (!result.attempted) {
    return;
  }
  metrics.plannerGroundingRepairAttempted = true;
  metrics.plannerGroundingRepairAccepted = result.accepted;
  metrics.plannerGroundingRepairRejected = !result.accepted;
  metrics.plannerGroundingRepairMode = result.mode;
  metrics.plannerGroundingRepairRejectedTargetCount =
    result.rejectedTargetCount;
  metrics.plannerGroundingRepairTargetFiles = result.targetFiles;
  metrics.plannerGroundingRepairReadFiles = result.readFiles;
  if (result.error) {
    metrics.plannerGroundingRepairError = result.error.slice(0, 500);
  }
  metrics.warnings = [
    ...(metrics.warnings ?? []),
    `planner_grounding_repair:${result.mode ?? "unknown"}:${result.accepted ? "accepted" : "rejected"}:${result.readFiles.length}:files`,
  ];
}

function plannerStallDetails(
  request: PlannerRequest,
  result?: {
    output?: string;
    structuredOutput?: unknown;
    metrics?: PlannerAttemptMetrics;
  },
  metrics?: PlannerAttemptMetrics,
): PlannerStallDetails {
  const resolvedMetrics = metrics ?? result?.metrics;
  return {
    ...(resolvedMetrics ? { metrics: resolvedMetrics } : {}),
    modelUsed: resolvedMetrics?.modelUsed,
    hasStructuredOutput: result ? Boolean(result.structuredOutput) : undefined,
    groundingConfidence: request.groundingContext?.confidence,
    groundingCandidateFiles: request.groundingContext?.candidateFiles.length,
    plannerScoutStatus: request.evidenceContext?.scoutStatus,
    outputPreview: outputPreview(result?.output),
  };
}

function plannerValidationFailureDetails(
  request: PlannerRequest,
  result: {
    output?: string;
    structuredOutput?: unknown;
    metrics?: PlannerAttemptMetrics;
  },
  metrics: PlannerAttemptMetrics,
  draftPlan: OneShotPlan,
  groundingValidation: PlannerGroundingValidationResult,
  finalPlannerReadFiles: string[],
  finalPlannerDiscoveredFiles: string[],
): PlannerStallDetails {
  const details = plannerStallDetails(request, result, metrics);
  return {
    ...details,
    rawOutput: result.output,
    structuredOutput: result.structuredOutput,
    draftPlan,
    groundingValidation,
    finalPlannerReadFiles,
    finalPlannerDiscoveredFiles,
    groundingEvidence: {
      routeCards: request.groundingContext?.routeCards ?? [],
      candidateFiles: (request.groundingContext?.candidateFiles ?? []).map(
        (candidate) => ({
          path: candidate.path,
          score: candidate.score,
          reasons: candidate.reasons,
          matchedTerms: candidate.matchedTerms,
        }),
      ),
      ticketExplicitNewSourceCandidates:
        request.groundingContext?.ticketExplicitNewSourceCandidates ?? [],
      riskFiles: request.groundingContext?.riskFiles ?? [],
      scoutStatus: request.evidenceContext?.scoutStatus,
      scoutReports: request.evidenceContext?.scoutReports.map((report) => ({
        workItemId: report.workItemId,
        status: report.status,
        verifiedInspectedFiles: report.verifiedInspectedFiles,
        symbols: report.symbols.slice(0, 8),
        testFiles: report.testFiles.slice(0, 8),
        commands: report.commands.slice(0, 4),
        blockers: report.blockers.slice(0, 6),
        confidence: report.confidence,
      })),
    },
  };
}

function combinePlannerMetrics(
  primary: PlannerMetrics,
  secondary?: PlannerMetrics,
): PlannerMetrics {
  if (!secondary) {
    return primary;
  }

  const MAX_COMBINED_RAW_TRACE_MESSAGES = 2_000;
  const primaryTokens = primary.tokensUsed;
  const secondaryTokens = secondary.tokensUsed;
  const modelUsage = mergeModelUsage(primary.modelUsage, secondary.modelUsage);
  const modelCostUsage = mergeModelCostUsage(
    primary.modelCostUsage,
    secondary.modelCostUsage,
  );
  const costUsd =
    primary.costUsd !== undefined || secondary.costUsd !== undefined
      ? (primary.costUsd ?? 0) + (secondary.costUsd ?? 0)
      : undefined;
  const costUsdExact =
    costUsd === undefined
      ? undefined
      : (primary.costUsd === undefined || primary.costUsdExact !== false) &&
        (secondary.costUsd === undefined || secondary.costUsdExact !== false);
  const tokensUsed =
    primaryTokens || secondaryTokens
      ? {
          input: (primaryTokens?.input ?? 0) + (secondaryTokens?.input ?? 0),
          output: (primaryTokens?.output ?? 0) + (secondaryTokens?.output ?? 0),
          cacheRead:
            (primaryTokens?.cacheRead ?? 0) +
              (secondaryTokens?.cacheRead ?? 0) || undefined,
          cacheWrite:
            (primaryTokens?.cacheWrite ?? 0) +
              (secondaryTokens?.cacheWrite ?? 0) || undefined,
        }
      : undefined;
  const combinedRawTrace =
    primary.sdkRawTrace || secondary.sdkRawTrace
      ? [
          ...(primary.sdkRawTrace ?? []),
          ...(secondary.sdkRawTrace ?? []),
        ].slice(0, MAX_COMBINED_RAW_TRACE_MESSAGES)
      : undefined;
  const rawTraceTruncatedByMerge =
    Boolean(primary.sdkRawTrace?.length && secondary.sdkRawTrace?.length) &&
    (primary.sdkRawTrace?.length ?? 0) + (secondary.sdkRawTrace?.length ?? 0) >
      MAX_COMBINED_RAW_TRACE_MESSAGES;
  const sdkLifecycleSummary: SdkLifecycleSummary | undefined =
    primary.sdkLifecycleSummary || secondary.sdkLifecycleSummary
      ? ({
          ...(secondary.sdkLifecycleSummary ?? {}),
          ...(primary.sdkLifecycleSummary ?? {}),
          rawTraceTruncated:
            Boolean(primary.sdkLifecycleSummary?.rawTraceTruncated) ||
            Boolean(secondary.sdkLifecycleSummary?.rawTraceTruncated) ||
            rawTraceTruncatedByMerge,
        } as SdkLifecycleSummary)
      : undefined;

  return {
    durationMs: primary.durationMs + secondary.durationMs,
    toolCalls: primary.toolCalls + secondary.toolCalls,
    tokensUsed,
    modelUsage,
    modelCostUsage,
    costUsd,
    costUsdExact,
    modelUsed: primary.modelUsed ?? secondary.modelUsed,
    llmToolCalls:
      (primary.llmToolCalls ?? primary.toolCalls) +
      (secondary.llmToolCalls ?? secondary.toolCalls),
    groundingCandidateFiles:
      primary.groundingCandidateFiles ?? secondary.groundingCandidateFiles,
    groundingConfidence:
      primary.groundingConfidence ?? secondary.groundingConfidence,
    groundingSource: primary.groundingSource ?? secondary.groundingSource,
    plannerOutputSanitized:
      primary.plannerOutputSanitized ?? secondary.plannerOutputSanitized,
    plannerOutputTruncatedChars:
      primary.plannerOutputTruncatedChars ??
      secondary.plannerOutputTruncatedChars,
    plannerOutputSanitization:
      primary.plannerOutputSanitization ?? secondary.plannerOutputSanitization,
    plannerStructuredOutputRepair:
      primary.plannerStructuredOutputRepair ??
      secondary.plannerStructuredOutputRepair,
    plannerSubagentAttempted:
      primary.plannerSubagentAttempted === undefined &&
      secondary.plannerSubagentAttempted === undefined
        ? undefined
        : Boolean(primary.plannerSubagentAttempted) ||
          Boolean(secondary.plannerSubagentAttempted),
    plannerSubagentAttemptMissing:
      primary.plannerSubagentAttemptMissing === undefined &&
      secondary.plannerSubagentAttemptMissing === undefined
        ? undefined
        : Boolean(primary.plannerSubagentAttempted) ||
            Boolean(secondary.plannerSubagentAttempted)
          ? false
          : Boolean(primary.plannerSubagentAttemptMissing) ||
            Boolean(secondary.plannerSubagentAttemptMissing),
    plannerSubagentOutcome: combinePlannerSubagentOutcome(
      primary.plannerSubagentOutcome,
      secondary.plannerSubagentOutcome,
    ),
    sdkLifecycleSummary,
    sdkRawTrace: combinedRawTrace,
    warnings: [...(primary.warnings ?? []), ...(secondary.warnings ?? [])],
    toolCallProfiles: [
      ...(primary.toolCallProfiles ?? []),
      ...(secondary.toolCallProfiles ?? []),
    ],
  };
}

function compactText(value: unknown, maxLength = 2_000): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return raw.length <= maxLength
    ? raw
    : `${raw.slice(0, maxLength - 3).trimEnd()}...`;
}

function summarizePriorPlan(plan: OneShotPlan | undefined): string {
  if (!plan) {
    return "No prior plan provided.";
  }
  const specs = plan.specs.map((spec) => ({
    id: spec.id,
    objective: spec.objective,
    targetFiles: spec.targetFiles.slice(0, 8),
    acceptanceCriteria: spec.acceptanceCriteria.slice(0, 5),
  }));
  return compactText(
    {
      summary: plan.summary,
      specs,
      assumptions: plan.assumptions.slice(0, 5),
      openQuestions: plan.openQuestions.slice(0, 5),
    },
    4_000,
  );
}

function summarizePriorReview(
  review: Record<string, unknown> | null | undefined,
): string {
  if (!review) {
    return "No prior review provided.";
  }
  const blockerKeys = [
    "blockers",
    "blockingFindings",
    "requiredChanges",
    "findings",
    "summary",
    "decision",
  ];
  const summary: Record<string, unknown> = {};
  for (const key of blockerKeys) {
    if (key in review) {
      summary[key] = review[key];
    }
  }
  return compactText(Object.keys(summary).length > 0 ? summary : review, 4_000);
}

function buildRevisionSection(context?: PlannerRevisionContext): string {
  const contractContext = context?.contractViolationContext;
  const retrofitPatchContext = context?.retrofitPatchConflictContext;
  const contractLines = contractContext
    ? [
        "",
        "### Plan Contract Violation Recovery",
        "The previous implementation attempt changed files outside the approved fileChangeContract. For every violating file, either add it to fileChangeContract with concrete supporting evidence and rationale, or explicitly reject it and constrain the next implementation attempt to approved files only.",
        `- Implementation version: ${contractContext.implementationVersion ?? "unknown"}`,
        `- Current plan version: ${contractContext.currentPlanVersion ?? "unknown"}`,
        `- Next plan version: ${contractContext.nextPlanVersion ?? "unknown"}`,
        `- Violating files: ${contractContext.violatingFiles.join(", ") || "none"}`,
        `- Previously editable files: ${contractContext.editableFiles.join(", ") || "none"}`,
        `- Changed files from rejected attempt: ${contractContext.changedFiles.join(", ") || "none"}`,
        `- Auto-replan attempt: ${contractContext.autoReplanAttempt ?? "unknown"}/${contractContext.autoReplanMaxAttempts ?? "unknown"}`,
      ].join("\n")
    : "";
  const retrofitPatchLines = retrofitPatchContext
    ? [
        "",
        "### Retrofit Patch Proof Recovery",
        "The previous retrofit implementation could not prove that every selected source commit was cleanly applied, already applied, adapted, or explicitly excluded. Replan the same run in place; do not treat this as a fresh ticket.",
        "For every conflicted source commit, either add the mapped target/adaptation files to fileChangeContract with concrete supporting evidence and rationale, or explicitly exclude/reject the commit with a durable rationale.",
        `- Implementation version: ${retrofitPatchContext.implementationVersion ?? "unknown"}`,
        `- Current plan version: ${retrofitPatchContext.currentPlanVersion ?? "unknown"}`,
        `- Next plan version: ${retrofitPatchContext.nextPlanVersion ?? "unknown"}`,
        `- Source Jira: ${retrofitPatchContext.sourceJiraKey ?? "unknown"}`,
        `- Source branch: ${retrofitPatchContext.sourceBranch ?? "unknown"}`,
        `- Target branch: ${retrofitPatchContext.targetBranch ?? "unknown"}`,
        `- Selected source SHAs: ${retrofitPatchContext.selectedShas.join(", ") || "none"}`,
        `- Changed files from rejected attempt: ${retrofitPatchContext.changedFiles.join(", ") || "none"}`,
        `- Allowed files before recovery: ${retrofitPatchContext.allowedFiles.join(", ") || "none"}`,
        `- Violations: ${retrofitPatchContext.violations.join(" | ") || "none"}`,
        `- Recovery subtype: ${retrofitPatchContext.recoverySubtype ?? "retrofit_patch_proof"}`,
        `- Auto-replan attempt: ${retrofitPatchContext.autoReplanAttempt ?? "unknown"}/${retrofitPatchContext.autoReplanMaxAttempts ?? "unknown"}`,
        "",
        "Per-commit status from rejected attempt:",
        ...retrofitPatchContext.perCommitStatus.map(
          (entry) =>
            `- ${entry.sha}: ${entry.status}; source=${entry.sourceFiles.join(", ") || "none"}; target=${entry.targetFiles.join(", ") || "none"}; adaptation=${entry.adaptationFiles.join(", ") || "none"}; conflict=${entry.conflictDiagnostics ?? "none"}`,
        ),
      ].join("\n")
    : "";
  return (
    `## Revision Context\n\n` +
    `This is a revision round based on reviewer feedback. Use this compact summary; do not re-read the entire prior JSON unless a specific blocker is ambiguous.\n\n` +
    `- Prior plan summary: ${summarizePriorPlan(context?.previousPlan)}\n` +
    `- Prior review blockers: ${summarizePriorReview(context?.previousReview)}` +
    contractLines +
    retrofitPatchLines
  );
}

function escapeExtendedRegexLiteral(value: string): string {
  return value.replace(/[\\.^$*+?()[\]{}|]/g, "\\$&");
}

function buildExactJiraKeyGrepPattern(sourceJiraKey: string): string {
  const escapedKey = escapeExtendedRegexLiteral(sourceJiraKey.trim());
  return `(^|[^A-Z0-9])${escapedKey}([^A-Z0-9]|$)`;
}

function buildRetrofitSection(context?: PlannerRetrofitContext): string {
  if (!context) {
    return "";
  }
  const exactJiraKeyPattern = buildExactJiraKeyGrepPattern(
    context.sourceJiraKey,
  );
  const commandExamples = RETROFIT_BASH_COMMANDS.flatMap((command) =>
    command.examples(context, exactJiraKeyPattern),
  );

  return [
    "## Retrofit Context",
    "",
    `- Source Jira key: ${context.sourceJiraKey}`,
    `- Source branch: origin/${context.sourceBranch}`,
    `- Target branch: origin/${context.targetBranch}`,
    "",
    "Use only local Git inspection commands through Bash:",
    ...commandExamples.map((example) => `- ${example}`),
  ].join("\n");
}

function buildPlannerFirstActionInstruction(request: PlannerRequest): string {
  const strongGrounding =
    isPlannerGroundingStrong(request.groundingContext) ||
    isPlannerEvidenceStrong(request.evidenceContext);
  const nativeSubagentsEnabled = plannerSubagentsEnabled(request);
  const lines = [
    "Exploration budget: about 2 minutes and roughly 50 Read/Glob/Grep calls total.",
    "The grounding sections above already list relevant files; prefer those over rediscovering the repository.",
  ];
  if (strongGrounding) {
    lines.push(
      nativeSubagentsEnabled
        ? "Grounding is strong: ask the scout to verify one narrow grounded detail, then read only the smallest necessary snippets from grounded files to confirm method-level details. Avoid broad searches unless evidence for a specific claim is missing."
        : "Grounding is strong: do not rediscover files. Read only the smallest necessary snippets from grounded files to confirm method-level details, and avoid broad searches unless evidence for a specific claim is missing.",
    );
  }
  if (nativeSubagentsEnabled) {
    lines.push(
      "Your first action must be one Agent scout call to `oneshot-grounding-scout`.",
      "After that Agent scout returns, or if it is denied, fails, times out, or exhausts turns, continue with focused Glob/Read/Grep repository inspection and still emit the structured implementation spec packet.",
    );
  } else {
    lines.push(
      "Start now with one focused Glob repository tool call, then use Read or Grep to inspect the relevant file(s). Only then produce the structured implementation spec packet.",
    );
  }
  return lines.join("\n");
}

export class ClaudePlannerProvider {
  constructor(private readonly promptComposer: PromptComposer) {}

  async generatePlan(request: PlannerRequest): Promise<PlannerResponse> {
    const qualSummary = [
      `- Requirements summary: ${request.qualificationSummary.requirementsSummary.join("; ") || "None provided"}`,
      `- Acceptance criteria present: ${request.qualificationSummary.acceptanceCriteriaPresent ? "yes" : "no"}`,
      `- Non-blocking warnings: ${request.qualificationSummary.nonBlockingWarnings.join("; ") || "None"}`,
    ].join("\n");

    const revisionSection = request.revision
      ? buildRevisionSection(request.revisionContext)
      : "";
    const retrofitSection = buildRetrofitSection(request.retrofitContext);
    const retrofitSourceEvidenceSection = request.retrofitSourceEvidence
      ? formatRetrofitSourceEvidenceForPrompt(request.retrofitSourceEvidence)
      : "";
    const retrofitPatchConflictContext =
      request.revisionContext?.retrofitPatchConflictContext;
    const retrofitWorkflowSection = isRetrofitWorkflowRequired({
      retrofitContext: request.retrofitContext,
      retrofitSourceEvidence: request.retrofitSourceEvidence,
      conflictContext: retrofitPatchConflictContext,
    })
      ? buildRetrofitWorkflowSection({
          workflowPrompt: await this.promptComposer.loadRetrofitWorkflowPrompt(),
          stage: "planner",
          retrofitContext: request.retrofitContext,
          retrofitSourceEvidence: request.retrofitSourceEvidence,
          conflictContext: retrofitPatchConflictContext,
        })
      : "";

    let prompt = await this.promptComposer.composePrompt("planning", {
      jiraKey: request.jiraKey,
      repoName: request.repoName,
      branchName: request.branchName,
      baseCommitSha: request.baseCommitSha,
      workspacePath: request.workspacePath,
      ticketSummary: request.ticketSummary,
      taskDescription: request.taskDescription,
      qualificationSummary: qualSummary,
      revisionSection,
      plannerFirstActionInstruction:
        buildPlannerFirstActionInstruction(request),
    });

    const baseSystemPromptText =
      await this.promptComposer.composeSystemPrompt("planning");

    const securityExtension = request.processingMode === "security_wiz"
      ? await this.promptComposer.loadSecurityPlanningExtension()
      : undefined;
    const wizCodeExtension = request.processingMode === "wiz_code"
      ? await this.promptComposer.loadWizCodePlanningExtension()
      : undefined;
    const sonarExtension = request.processingMode === "sonar_autofix"
      ? await this.promptComposer.loadSonarPlanningExtension()
      : undefined;

    const systemPromptText = [
      baseSystemPromptText,
      securityExtension,
      wizCodeExtension,
      sonarExtension,
    ]
      .filter((section): section is string => !!section)
      .join("\n\n---\n\n");

    if (request.repoScanSummary) {
      prompt = request.repoScanSummary + "\n\n---\n\n" + prompt;
    }

    if (retrofitSection) {
      prompt = retrofitSection + "\n\n---\n\n" + prompt;
    }

    if (retrofitSourceEvidenceSection) {
      prompt = retrofitSourceEvidenceSection + "\n\n---\n\n" + prompt;
    }

    if (retrofitWorkflowSection) {
      prompt = retrofitWorkflowSection + "\n\n---\n\n" + prompt;
    }

    if (request.groundingSummary) {
      prompt = request.groundingSummary + "\n\n---\n\n" + prompt;
    }

    const evidenceSummary =
      request.evidenceSummary ||
      (request.evidenceContext
        ? formatPlannerEvidenceForPrompt(request.evidenceContext)
        : "");
    if (evidenceSummary) {
      prompt = evidenceSummary + "\n\n---\n\n" + prompt;
    }

    if (request.routeCardContext) {
      prompt = request.routeCardContext + "\n\n---\n\n" + prompt;
    }

    if (request.additionalScopeSection) {
      prompt = request.additionalScopeSection + "\n\n---\n\n" + prompt;
    }

    const nativeSubagentInstruction =
      buildPlannerNativeSubagentInstruction(request);
    if (nativeSubagentInstruction) {
      prompt = prompt + "\n\n---\n\n" + nativeSubagentInstruction;
    }

    const plannerSkillChecklist = buildPlannerSkillChecklistInstruction(request);
    if (plannerSkillChecklist) {
      prompt = prompt + "\n\n---\n\n" + plannerSkillChecklist;
    }

    // Prompt size guard. Claude's context window is 1M tokens (beta enabled), but we set a
    // practical cap to catch runaway context (oversized tickets, large repo scans, ballooned
    // revision context) before it turns into a confusing API timeout or silent failure.
    // Counts both user-turn prompt and system-slot append — they both travel in the same
    // Bedrock request so both count against the cap.
    const MAX_PROMPT_BYTES = 400_000;
    const finalPrompt = prompt;
    const userPromptBytes = Buffer.byteLength(finalPrompt, "utf8");
    const systemPromptBytes = systemPromptText
      ? Buffer.byteLength(systemPromptText, "utf8")
      : 0;
    const totalPromptBytes = userPromptBytes + systemPromptBytes;
    if (totalPromptBytes > MAX_PROMPT_BYTES) {
      throw new Error(
        `OneShot planner prompt exceeds maximum size: ${totalPromptBytes} bytes ` +
          `(user=${userPromptBytes}, system=${systemPromptBytes}) > ${MAX_PROMPT_BYTES} bytes. ` +
          `This usually indicates runaway context (oversized ticket, large repo scan, ballooned revision context). ` +
          `Reduce input size or increase MAX_PROMPT_BYTES in src/oneshot/providers/claude-planner.ts.`,
      );
    }
    logger.debug(
      {
        jiraKey: request.jiraKey,
        stage: "planner",
        userPromptBytes,
        systemPromptBytes,
        totalPromptBytes,
      },
      "[PROMPT_SIZE] Prompt size check passed",
    );

    const repoId = registerRepoFromPath(
      request.workspacePath,
      `oneshot-run-${request.jiraKey}-planner`,
    );

    // Apply attempt overrides (for progressive retry strategy)
    const overrides = request.attemptOverrides ?? {};
    const useOutputSchema = overrides.useOutputSchema === true;
    const allowedTools = buildPlannerAllowedTools(request);
    const plannerSdkCustomization = {
      ...buildPlannerSkillOptions(request),
      ...buildPlannerSubagentOptions(request, allowedTools),
    };
    const toolBudgetGuard =
      request.retrofitContext && overrides.toolBudgetGuard
        ? {
            ...overrides.toolBudgetGuard,
            tools: allowedTools,
          }
        : overrides.toolBudgetGuard;
    const allowedBashCommandPatterns = request.retrofitContext
      ? RETROFIT_BASH_ALLOWLIST_PATTERNS
      : undefined;
    validatePlannerToolPolicy({
      retrofitContextPresent: Boolean(request.retrofitContext),
      allowedTools,
      allowedBashCommandPatterns,
    });

    let result = await runAgent({
      taskId: `oneshot-planner-${request.jiraKey}-${Date.now()}`,
      sdkStage: "planning",
      taskPrompt: finalPrompt,
      ...(systemPromptText ? { systemAppend: systemPromptText } : {}),
      repoIds: [repoId],
      additionalDirectories: request.additionalDirectories,
      permissionLevel: "read_only",
      allowedTools,
      ...plannerSdkCustomization,
      settingSources: [],
      allowedBashCommandPatterns,
      outputSchema: useOutputSchema ? ONE_SHOT_PLAN_OUTPUT_SCHEMA : undefined,
      timeoutMs: overrides.timeoutMs ?? 12 * 60 * 1000,
      maxTurns: overrides.maxTurns ?? 40,
      maxBudgetUsd: 25,
      bedrockConfig: overrides.bedrockConfig,
      permissionMode: overrides.permissionMode,
      toolVisibility: overrides.toolVisibility,
      toolGuard: overrides.toolGuard,
      toolSprawlGuard:
        overrides.toolSprawlGuard === false ? undefined : { enabled: true },
      toolBudgetGuard,
      sdkTraceMode: overrides.sdkTraceMode,
      sdkStallThinkingPreview: overrides.sdkStallThinkingPreview,
      // Streaming observability for planner stall detection
      includePartialMessages: true,
      idleTimeoutMs: overrides.idleTimeoutMs ?? 120_000,
      postToolIdleTimeoutMs: overrides.postToolIdleTimeoutMs,
      compactionGraceMs: 120_000,
    });
    let discoveryMetrics: PlannerMetrics | undefined;
    const groundingStrong =
      isPlannerGroundingStrong(request.groundingContext) ||
      isPlannerEvidenceStrong(request.evidenceContext);
    let resultRepositoryToolCalls = plannerRepositoryProgressToolCalls(
      result.metrics,
      request,
    );

    if (
      !result.success &&
      (result.failureKind === "wall_timeout" ||
        result.failureKind === "idle_timeout") &&
      resultRepositoryToolCalls === 0 &&
      !result.structuredOutput
    ) {
      throw new PlannerStallError(
        result.error ||
          "OneShot planner made no repository-tool progress and produced no structured plan before timing out",
        "no_progress",
        plannerStallDetails(request, result),
      );
    }

    if (!result.success) {
      // Throw typed error with failure classification for retry logic
      throw new PlannerStallError(
        result.error || "OneShot planner failed",
        result.failureKind ?? "other",
        plannerStallDetails(request, result),
      );
    }

    if (resultRepositoryToolCalls === 0) {
      if (groundingStrong) {
        logger.warn(
          {
            jiraKey: request.jiraKey,
            repoName: request.repoName,
            groundingCandidateFiles:
              request.groundingContext?.candidateFiles.length ?? 0,
            groundingSnippets: request.groundingContext?.snippets.length ?? 0,
          },
          "Planner produced output without repository-tool inspection; accepting deterministic planner grounding",
        );
      } else if (
        process.env.ONESHOT_PLANNER_SDK_DISCOVERY_FALLBACK === "true"
      ) {
        logger.warn(
          {
            jiraKey: request.jiraKey,
            repoName: request.repoName,
          },
          "Planner produced output without repository-tool inspection; running tool-backed discovery fallback",
        );

        const discovery = await this.runToolBackedDiscovery(
          request,
          finalPrompt,
          systemPromptText,
          repoId,
          overrides,
        );
        discoveryMetrics = discovery.metrics;

        result = await runAgent({
          taskId: `oneshot-planner-grounded-${request.jiraKey}-${Date.now()}`,
          sdkStage: "planning",
          taskPrompt:
            `## Tool-backed repository discovery from this planner invocation\n\n` +
            `${discovery.output}\n\n---\n\n` +
            finalPrompt,
          ...(systemPromptText ? { systemAppend: systemPromptText } : {}),
          repoIds: [repoId],
          additionalDirectories: request.additionalDirectories,
          permissionLevel: "read_only",
          allowedTools,
          ...plannerSdkCustomization,
          settingSources: [],
          allowedBashCommandPatterns,
          outputSchema: useOutputSchema
            ? ONE_SHOT_PLAN_OUTPUT_SCHEMA
            : undefined,
          timeoutMs: overrides.timeoutMs ?? 12 * 60 * 1000,
          maxTurns: overrides.maxTurns ?? 40,
          maxBudgetUsd: 25,
          bedrockConfig: overrides.bedrockConfig,
          permissionMode: overrides.permissionMode,
          toolVisibility: overrides.toolVisibility,
          toolGuard: overrides.toolGuard,
          toolSprawlGuard:
            overrides.toolSprawlGuard === false ? undefined : { enabled: true },
          toolBudgetGuard,
          sdkTraceMode: overrides.sdkTraceMode,
          sdkStallThinkingPreview: overrides.sdkStallThinkingPreview,
          includePartialMessages: true,
          idleTimeoutMs: overrides.idleTimeoutMs ?? 120_000,
          postToolIdleTimeoutMs: overrides.postToolIdleTimeoutMs,
          compactionGraceMs: 120_000,
        });

        if (!result.success) {
          throw new PlannerStallError(
            result.error ||
              "OneShot planner failed after tool-backed discovery",
            result.failureKind ?? "other",
            plannerStallDetails(
              request,
              result,
              combinePlannerMetrics(result.metrics, discoveryMetrics),
            ),
          );
        }
        resultRepositoryToolCalls = plannerRepositoryProgressToolCalls(
          result.metrics,
          request,
        );
      } else {
        throw new PlannerStallError(
          "OneShot planner produced output without repository-tool inspection or strong deterministic grounding",
          "no_progress",
          plannerStallDetails(request, result),
        );
      }
    }

    let combinedMetrics = combinePlannerMetrics(
      result.metrics,
      discoveryMetrics,
    );

    if (
      plannerRepositoryProgressToolCalls(combinedMetrics, request) === 0 &&
      !groundingStrong
    ) {
      throw new PlannerStallError(
        "OneShot planner produced output without repository-tool inspection",
        "no_progress",
        plannerStallDetails(request, result, combinedMetrics),
      );
    }

    const resolvedPlan = this.resolvePlan(
      result.output,
      result.structuredOutput,
      request,
      result.metrics,
    );
    const toolLoop = plannerToolLoopMetrics(combinedMetrics, request);
    Object.assign(combinedMetrics, toolLoop);
    const parsedPlan = resolvedPlan.plan;
    const groundedPlan = applyGroundingToPlan(
      parsedPlan,
      request.groundingContext,
      request.evidenceContext,
    );
    const postGroundingSanitized = sanitizePlannerDiscoveries(groundedPlan);
    const postGroundingRetrofitNormalized =
      normalizeRetrofitPlanFromQualification({
        value: postGroundingSanitized.value,
        retrofitSourceEvidence: request.retrofitSourceEvidence,
        requireRetrofitContract: Boolean(
          request.retrofitContext || request.retrofitSourceEvidence,
        ),
        normalizationReport: {
          ...emptyRetrofitPlanNormalizationReport(),
          normalizedOptionalFields:
            postGroundingSanitized.report.normalizedOptionalFields,
        },
      });
    const sanitizationReport = mergePlannerDiscoverySanitizationReports(
      resolvedPlan.sanitizationReport,
      postGroundingSanitized.report,
    );
    recordPlannerSanitizationMetrics(combinedMetrics, sanitizationReport);
    recordRetrofitPlanNormalizationMetrics(
      combinedMetrics,
      resolvedPlan.retrofitPlanNormalization,
    );
    recordRetrofitPlanNormalizationMetrics(
      combinedMetrics,
      postGroundingRetrofitNormalized.report,
    );
    if (resolvedPlan.structuredOutputRepair?.repaired) {
      combinedMetrics.plannerStructuredOutputRepair =
        resolvedPlan.structuredOutputRepair;
      combinedMetrics.warnings = [
        ...(combinedMetrics.warnings ?? []),
        "planner_structured_output_repaired",
      ];
    }
    if (postGroundingRetrofitNormalized.report.missingAfterNormalization) {
      throw new PlannerStallError(
        "retrofit_contract_missing_after_normalization: Retrofit planner output did not include or seed plannerDiscoveries.retrofitEvidence or plannerDiscoveries.retrofitExecutionContract.",
        "retrofit_contract_missing_after_normalization",
        {
          metrics: combinedMetrics,
          hasStructuredOutput: result.structuredOutput !== undefined,
          rawOutput: result.output,
          structuredOutput: result.structuredOutput,
          outputPreview: outputPreview(result.output),
          retrofitPlanNormalization: postGroundingRetrofitNormalized.report,
        },
      );
    }
    let structuredPlan = parseOneShotPlan(postGroundingRetrofitNormalized.value);
    let finalPlannerReadFiles = finalPlannerReadFilesFromMetrics(
      result.metrics,
      request.workspacePath,
    );
    let finalPlannerDiscoveredFiles = finalPlannerDiscoveredFilesFromMetrics(
      result.metrics,
      request.workspacePath,
    );
    const validationOptions = {
      finalPlannerReadFiles,
      finalPlannerDiscoveredFiles,
      allowAdjacentTestWithRationale:
        process.env.ONESHOT_PLANNER_SOFT_TEST_VALIDATION?.trim().toLowerCase() !==
        "false",
    };
    const sourceRecovery = validatePlanWithSourceRationaleRecovery(
      structuredPlan,
      request,
      validationOptions,
    );
    recordSourceRecoveryMetrics(combinedMetrics, sourceRecovery);
    let groundingValidation = sourceRecovery.validation;
    let rawOutput = result.output;
    if (!groundingValidation.ok) {
      const groundingRepair = await this.attemptGroundingRepair({
        request,
        repoId,
        draftPlan: structuredPlan,
        validation: groundingValidation,
        validationOptions,
        overrides,
        bedrockConfig: overrides.bedrockConfig,
        systemPromptText,
      });
      if (groundingRepair.metrics) {
        combinedMetrics = combinePlannerMetrics(
          combinedMetrics,
          groundingRepair.metrics,
        );
      }
      recordGroundingRepairMetrics(combinedMetrics, groundingRepair);
      if (
        groundingRepair.accepted &&
        groundingRepair.plan &&
        groundingRepair.validation &&
        groundingRepair.finalPlannerReadFiles
      ) {
        structuredPlan = groundingRepair.plan;
        groundingValidation = groundingRepair.validation;
        finalPlannerReadFiles = groundingRepair.finalPlannerReadFiles;
        finalPlannerDiscoveredFiles =
          groundingRepair.finalPlannerDiscoveredFiles ??
          finalPlannerDiscoveredFiles;
        rawOutput = groundingRepair.rawOutput ?? rawOutput;
      }
    }
    if (!groundingValidation.ok) {
      const error = new PlannerGroundingValidationError(
        groundingValidation.errors,
        groundingValidation,
      ) as PlannerErrorWithAttemptDetails;
      error.plannerAttemptDetails = plannerValidationFailureDetails(
        request,
        result,
        combinedMetrics,
        structuredPlan,
        groundingValidation,
        finalPlannerReadFiles,
        finalPlannerDiscoveredFiles,
      );
      throw error;
    }
    const combinedRepositoryToolCalls = plannerRepositoryProgressToolCalls(
      combinedMetrics,
      request,
    );
    const scoutStrong =
      request.evidenceContext?.scoutReports.some(
        (report) =>
          report.status === "valid" && report.verifiedInspectedFiles.length > 0,
      ) ?? false;
    const groundingSource =
      combinedRepositoryToolCalls > 0
        ? groundingStrong
          ? "mixed"
          : "llm_tools"
        : scoutStrong
          ? "scouts"
          : "deterministic";
    recordPlannerSubagentAttemptMetrics(combinedMetrics, request);
    const warnings = [
      ...(combinedMetrics.warnings ?? []),
      ...groundingValidation.warnings,
      ...(combinedRepositoryToolCalls === 0 && groundingStrong
        ? ["planner_grounded_without_llm_tools"]
        : []),
    ];

    logger.info(
      {
        jiraKey: request.jiraKey,
        repoName: request.repoName,
        impactedFiles: getPlanImpactedFiles(structuredPlan).length,
        toolCalls: combinedMetrics.toolCalls,
        groundingSource,
      },
      "OneShot planner completed",
    );

    return {
      plan: structuredPlan,
      rawOutput,
      metrics: {
        ...combinedMetrics,
        llmToolCalls: combinedMetrics.toolCalls,
        groundingCandidateFiles:
          request.groundingContext?.candidateFiles.length,
        groundingConfidence:
          request.evidenceContext?.confidence ??
          request.groundingContext?.confidence,
        groundingSource,
        plannerScoutStatus: request.evidenceContext?.scoutStatus,
        scoutReports: request.evidenceContext?.scoutReports.length,
        warnings,
      },
    };
  }

  private async attemptGroundingRepair(input: {
    request: PlannerRequest;
    repoId: string;
    draftPlan: OneShotPlan;
    validation: PlannerGroundingValidationResult;
    validationOptions: {
      finalPlannerReadFiles: string[];
      finalPlannerDiscoveredFiles: string[];
      allowAdjacentTestWithRationale: boolean;
    };
    overrides: PlannerAttemptOverrides;
    bedrockConfig?: Partial<BedrockConfig>;
    systemPromptText?: string;
  }): Promise<GroundingRepairResult> {
    if (!groundingRepairEnabled()) {
      return {
        attempted: false,
        accepted: false,
        targetFiles: [],
        readFiles: [],
      };
    }

    const targetFiles = plannerGroundingRepairTargets(
      input.validation,
      input.request.workspacePath,
    );
    if (targetFiles.length === 0) {
      return {
        attempted: false,
        accepted: false,
        targetFiles: [],
        readFiles: [],
      };
    }

    const snippets = readGroundingRepairSnippets(
      input.request.workspacePath,
      targetFiles,
    );
    const readFiles = snippets.map((snippet) => snippet.targetFile);
    if (snippets.length === 0) {
      return {
        attempted: true,
        accepted: false,
        mode: "patch",
        rejectedTargetCount:
          plannerGroundingRejectedTargetFiles(input.validation).length,
        targetFiles,
        readFiles,
        error: "no readable rejected target files",
      };
    }

    const rejectedTargetFiles = plannerGroundingRejectedTargetFiles(
      input.validation,
    );
    const rejectedTargetCount = rejectedTargetFiles.length;
    const patchRepair = await this.attemptGroundingPatchRepair({
      ...input,
      targetFiles,
      rejectedTargetFiles,
      rejectedTargetCount,
      snippets,
      readFiles,
    });
    if (patchRepair.accepted) {
      return patchRepair;
    }

    let repairResult: Awaited<ReturnType<typeof runAgent>>;
    try {
      repairResult = await runAgent({
        taskId: `oneshot-planner-grounding-repair-${input.request.jiraKey}-${Date.now()}`,
        sdkStage: "planning",
        taskPrompt: buildGroundingRepairPrompt({
          request: input.request,
          draftPlan: input.draftPlan,
          validation: input.validation,
          snippets,
        }),
        ...(input.systemPromptText
          ? { systemAppend: input.systemPromptText }
          : {}),
        repoIds: [input.repoId],
        permissionLevel: "read_only",
        allowedTools: ["Read"],
        settingSources: [],
        outputSchema: ONE_SHOT_PLAN_OUTPUT_SCHEMA,
        timeoutMs: Math.min(input.overrides.timeoutMs ?? 300_000, 300_000),
        maxTurns: Math.min(input.overrides.maxTurns ?? 8, 8),
        maxBudgetUsd: 5,
        bedrockConfig: input.bedrockConfig,
        permissionMode: input.overrides.permissionMode,
        toolVisibility: input.overrides.toolVisibility,
        toolGuard: input.overrides.toolGuard,
        toolSprawlGuard: undefined,
        toolBudgetGuard: {
          enabled: true,
          tools: ["Read"],
          maxCalls: Math.max(1, readFiles.length),
          message:
            "Grounding repair has all required snippets. Do not read additional files; emit the repaired OneShot plan JSON now.",
        },
        sdkTraceMode: input.overrides.sdkTraceMode,
        sdkStallThinkingPreview: input.overrides.sdkStallThinkingPreview,
        includePartialMessages: true,
        idleTimeoutMs: Math.min(
          input.overrides.idleTimeoutMs ?? 120_000,
          120_000,
        ),
        postToolIdleTimeoutMs:
          input.overrides.postToolIdleTimeoutMs !== undefined
            ? Math.min(input.overrides.postToolIdleTimeoutMs, 30_000)
            : undefined,
        compactionGraceMs: 60_000,
      });
    } catch (error) {
      return {
        attempted: true,
        accepted: false,
        mode: "full_plan_fallback",
        rejectedTargetCount,
        targetFiles,
        readFiles,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const repairMetrics = patchRepair.metrics
      ? combinePlannerMetrics(repairResult.metrics, patchRepair.metrics)
      : repairResult.metrics;
    const disallowedToolUse = validateRepairToolUse(
      repairMetrics,
      readFiles,
      input.request.workspacePath,
    );
    if (disallowedToolUse) {
      return {
        attempted: true,
        accepted: false,
        mode: "full_plan_fallback",
        rejectedTargetCount,
        targetFiles,
        readFiles,
        metrics: repairMetrics,
        rawOutput: repairResult.output,
        structuredOutput: repairResult.structuredOutput,
        error: disallowedToolUse,
      };
    }

    if (!repairResult.success) {
      return {
        attempted: true,
        accepted: false,
        mode: "full_plan_fallback",
        rejectedTargetCount,
        targetFiles,
        readFiles,
        metrics: repairMetrics,
        rawOutput: repairResult.output,
        structuredOutput: repairResult.structuredOutput,
        error: repairResult.error || "planner grounding repair failed",
      };
    }

    try {
      const resolvedPlan = this.resolvePlan(
        repairResult.output,
        repairResult.structuredOutput,
        input.request,
        repairMetrics,
      );
      const groundedPlan = applyGroundingToPlan(
        resolvedPlan.plan,
        input.request.groundingContext,
        input.request.evidenceContext,
      );
      const sanitized = sanitizePlannerDiscoveries(groundedPlan);
      const retrofitNormalized = normalizeRetrofitPlanFromQualification({
        value: sanitized.value,
        retrofitSourceEvidence: input.request.retrofitSourceEvidence,
        requireRetrofitContract: Boolean(
          input.request.retrofitContext ||
            input.request.retrofitSourceEvidence,
        ),
        normalizationReport:
          resolvedPlan.retrofitPlanNormalization ??
          emptyRetrofitPlanNormalizationReport(),
      });
      const repairedPlan = parseOneShotPlan(retrofitNormalized.value);
      const finalPlannerReadFiles = uniqueStrings([
        ...input.validationOptions.finalPlannerReadFiles,
        ...readFiles,
      ]);
      const sourceRecovery = validatePlanWithSourceRationaleRecovery(
        repairedPlan,
        input.request,
        {
          ...input.validationOptions,
          finalPlannerReadFiles,
        },
      );
      return {
        attempted: true,
        accepted: sourceRecovery.validation.ok,
        mode: "full_plan_fallback",
        rejectedTargetCount,
        targetFiles,
        readFiles,
        plan: sourceRecovery.validation.ok ? repairedPlan : undefined,
        validation: sourceRecovery.validation,
        finalPlannerReadFiles,
        finalPlannerDiscoveredFiles:
          input.validationOptions.finalPlannerDiscoveredFiles,
        metrics: repairMetrics,
        rawOutput: repairResult.output,
        structuredOutput: repairResult.structuredOutput,
        ...(sourceRecovery.validation.ok
          ? {}
          : { error: sourceRecovery.validation.errors.join("; ") }),
      };
    } catch (error) {
      return {
        attempted: true,
        accepted: false,
        mode: "full_plan_fallback",
        rejectedTargetCount,
        targetFiles,
        readFiles,
        metrics: repairMetrics,
        rawOutput: repairResult.output,
        structuredOutput: repairResult.structuredOutput,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async attemptGroundingPatchRepair(input: {
    request: PlannerRequest;
    repoId: string;
    draftPlan: OneShotPlan;
    validation: PlannerGroundingValidationResult;
    validationOptions: {
      finalPlannerReadFiles: string[];
      finalPlannerDiscoveredFiles: string[];
      allowAdjacentTestWithRationale: boolean;
    };
    overrides: PlannerAttemptOverrides;
    bedrockConfig?: Partial<BedrockConfig>;
    systemPromptText?: string;
    targetFiles: string[];
    rejectedTargetFiles: string[];
    rejectedTargetCount: number;
    snippets: GroundingRepairSnippet[];
    readFiles: string[];
  }): Promise<GroundingRepairResult> {
    let repairResult: Awaited<ReturnType<typeof runAgent>>;
    try {
      repairResult = await runAgent({
        taskId: `oneshot-planner-grounding-patch-repair-${input.request.jiraKey}-${Date.now()}`,
        sdkStage: "planning",
        taskPrompt: buildGroundingPatchRepairPrompt({
          request: input.request,
          draftPlan: input.draftPlan,
          validation: input.validation,
          rejectedTargetFiles: input.rejectedTargetFiles,
          snippets: input.snippets,
        }),
        ...(input.systemPromptText
          ? { systemAppend: input.systemPromptText }
          : {}),
        repoIds: [input.repoId],
        permissionLevel: "read_only",
        allowedTools: ["Read"],
        settingSources: [],
        outputSchema: ONE_SHOT_GROUNDING_REPAIR_PATCH_OUTPUT_SCHEMA,
        timeoutMs: Math.min(input.overrides.timeoutMs ?? 180_000, 180_000),
        maxTurns: Math.min(input.overrides.maxTurns ?? 4, 4),
        maxBudgetUsd: 3,
        bedrockConfig: input.bedrockConfig,
        permissionMode: input.overrides.permissionMode,
        toolVisibility: input.overrides.toolVisibility,
        toolGuard: input.overrides.toolGuard,
        toolSprawlGuard: undefined,
        toolBudgetGuard: {
          enabled: true,
          tools: ["Read"],
          maxCalls: Math.max(1, input.readFiles.length),
          message:
            "Grounding patch repair has all required snippets. Do not read additional files; emit the patch JSON now.",
        },
        sdkTraceMode: input.overrides.sdkTraceMode,
        sdkStallThinkingPreview: input.overrides.sdkStallThinkingPreview,
        includePartialMessages: true,
        idleTimeoutMs: Math.min(
          input.overrides.idleTimeoutMs ?? 120_000,
          120_000,
        ),
        postToolIdleTimeoutMs:
          input.overrides.postToolIdleTimeoutMs !== undefined
            ? Math.min(input.overrides.postToolIdleTimeoutMs, 30_000)
            : undefined,
        compactionGraceMs: 60_000,
      });
    } catch (error) {
      return {
        attempted: true,
        accepted: false,
        mode: "patch",
        rejectedTargetCount: input.rejectedTargetCount,
        targetFiles: input.targetFiles,
        readFiles: input.readFiles,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const repairMetrics = repairResult.metrics;
    const disallowedToolUse = validateRepairToolUse(
      repairMetrics,
      input.readFiles,
      input.request.workspacePath,
    );
    if (disallowedToolUse) {
      return {
        attempted: true,
        accepted: false,
        mode: "patch",
        rejectedTargetCount: input.rejectedTargetCount,
        targetFiles: input.targetFiles,
        readFiles: input.readFiles,
        metrics: repairMetrics,
        rawOutput: repairResult.output,
        structuredOutput: repairResult.structuredOutput,
        error: disallowedToolUse,
      };
    }

    if (!repairResult.success) {
      return {
        attempted: true,
        accepted: false,
        mode: "patch",
        rejectedTargetCount: input.rejectedTargetCount,
        targetFiles: input.targetFiles,
        readFiles: input.readFiles,
        metrics: repairMetrics,
        rawOutput: repairResult.output,
        structuredOutput: repairResult.structuredOutput,
        error: repairResult.error || "planner grounding patch repair failed",
      };
    }

    try {
      const patchOutput = parseGroundingRepairPatchOutput(
        repairResult.output,
        repairResult.structuredOutput,
      );
      const patchedPlan = applyGroundingRepairPatchToPlan(
        input.draftPlan,
        patchOutput,
        input.rejectedTargetFiles,
      );
      const groundedPlan = applyGroundingToPlan(
        patchedPlan,
        input.request.groundingContext,
        input.request.evidenceContext,
      );
      const sanitized = sanitizePlannerDiscoveries(groundedPlan);
      const retrofitNormalized = normalizeRetrofitPlanFromQualification({
        value: sanitized.value,
        retrofitSourceEvidence: input.request.retrofitSourceEvidence,
        requireRetrofitContract: Boolean(
          input.request.retrofitContext ||
            input.request.retrofitSourceEvidence,
        ),
        normalizationReport: {
          ...emptyRetrofitPlanNormalizationReport(),
          normalizedOptionalFields:
            sanitized.report.normalizedOptionalFields,
        },
      });
      const repairedPlan = parseOneShotPlan(retrofitNormalized.value);
      const finalPlannerReadFiles = uniqueStrings([
        ...input.validationOptions.finalPlannerReadFiles,
        ...input.readFiles,
      ]);
      const sourceRecovery = validatePlanWithSourceRationaleRecovery(
        repairedPlan,
        input.request,
        {
          ...input.validationOptions,
          finalPlannerReadFiles,
        },
      );
      return {
        attempted: true,
        accepted: sourceRecovery.validation.ok,
        mode: "patch",
        rejectedTargetCount: input.rejectedTargetCount,
        targetFiles: input.targetFiles,
        readFiles: input.readFiles,
        plan: sourceRecovery.validation.ok ? repairedPlan : undefined,
        validation: sourceRecovery.validation,
        finalPlannerReadFiles,
        finalPlannerDiscoveredFiles:
          input.validationOptions.finalPlannerDiscoveredFiles,
        metrics: repairMetrics,
        rawOutput: repairResult.output,
        structuredOutput: repairResult.structuredOutput,
        ...(sourceRecovery.validation.ok
          ? {}
          : { error: sourceRecovery.validation.errors.join("; ") }),
      };
    } catch (error) {
      return {
        attempted: true,
        accepted: false,
        mode: "patch",
        rejectedTargetCount: input.rejectedTargetCount,
        targetFiles: input.targetFiles,
        readFiles: input.readFiles,
        metrics: repairMetrics,
        rawOutput: repairResult.output,
        structuredOutput: repairResult.structuredOutput,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async runToolBackedDiscovery(
    request: PlannerRequest,
    finalPrompt: string,
    systemPromptText: string | undefined,
    repoId: string,
    overrides: PlannerAttemptOverrides,
  ): Promise<{ output: string; metrics: PlannerMetrics }> {
    const discoveryPrompt =
      `You are running a required repository discovery pass before final planning.\n\n` +
      `Hard requirements:\n` +
      `- Your first action must be a Glob tool call.\n` +
      `- Use at least one Read or Grep call after Glob.\n` +
      `- Do not produce the final OneShotPlan JSON in this pass.\n` +
      `- Return concise markdown notes listing discovered files, relevant patterns, validation commands, and uncertainty.\n\n` +
      `Original planning prompt follows for context only:\n\n` +
      finalPrompt;

    const discoveryResult = await runAgent({
      taskId: `oneshot-planner-discovery-${request.jiraKey}-${Date.now()}`,
      sdkStage: "planning",
      taskPrompt: discoveryPrompt,
      ...(systemPromptText ? { systemAppend: systemPromptText } : {}),
      repoIds: [repoId],
      additionalDirectories: request.additionalDirectories,
      permissionLevel: "read_only",
      allowedTools: ["Read", "Glob", "Grep"],
      settingSources: [],
      timeoutMs: Math.min(overrides.timeoutMs ?? 12 * 60 * 1000, 180_000),
      maxTurns: Math.min(overrides.maxTurns ?? 40, 16),
      maxBudgetUsd: 5,
      bedrockConfig: overrides.bedrockConfig,
      permissionMode: overrides.permissionMode,
      toolVisibility: overrides.toolVisibility,
      toolGuard: overrides.toolGuard,
      toolSprawlGuard:
        overrides.toolSprawlGuard === false ? undefined : { enabled: true },
      toolBudgetGuard: overrides.toolBudgetGuard,
      sdkTraceMode: overrides.sdkTraceMode,
      sdkStallThinkingPreview: overrides.sdkStallThinkingPreview,
      includePartialMessages: true,
      idleTimeoutMs: Math.min(overrides.idleTimeoutMs ?? 120_000, 120_000),
      postToolIdleTimeoutMs:
        overrides.postToolIdleTimeoutMs !== undefined
          ? Math.min(overrides.postToolIdleTimeoutMs, 30_000)
          : undefined,
      compactionGraceMs: 60_000,
    });

    if (!discoveryResult.success) {
      throw new PlannerStallError(
        discoveryResult.error || "OneShot planner discovery fallback failed",
        discoveryResult.failureKind ?? "other",
        plannerStallDetails(request, discoveryResult),
      );
    }

    if (
      plannerRepositoryProgressToolCalls(discoveryResult.metrics, request) === 0
    ) {
      throw new PlannerStallError(
        "OneShot planner discovery fallback made no repository-tool progress",
        "no_progress",
        plannerStallDetails(request, discoveryResult),
      );
    }

    return {
      output: discoveryResult.output,
      metrics: discoveryResult.metrics,
    };
  }

  private resolvePlan(
    output: string,
    structuredOutput: unknown,
    request: PlannerRequest,
    metrics?: PlannerAttemptMetrics,
  ): {
    plan: OneShotPlan;
    sanitizationReport: PlannerDiscoverySanitizationReport;
    structuredOutputRepair?: PlannerStructuredOutputRepairReport;
    retrofitPlanNormalization?: RetrofitPlanNormalizationReport;
  } {
    if (structuredOutput !== undefined) {
      let initialSchemaValidationErrors: PlannerSchemaValidationIssue[] = [];
      try {
        const sanitized = sanitizePlannerDiscoveries(structuredOutput);
        const retrofitNormalized = normalizeRetrofitPlanFromQualification({
          value: sanitized.value,
          retrofitSourceEvidence: request.retrofitSourceEvidence,
          requireRetrofitContract: Boolean(
            request.retrofitContext || request.retrofitSourceEvidence,
          ),
          normalizationReport: {
            ...emptyRetrofitPlanNormalizationReport(),
            normalizedOptionalFields:
              sanitized.report.normalizedOptionalFields,
          },
        });
        if (retrofitNormalized.report.missingAfterNormalization) {
          throw new PlannerStallError(
            "retrofit_contract_missing_after_normalization: Retrofit planner output did not include or seed plannerDiscoveries.retrofitEvidence or plannerDiscoveries.retrofitExecutionContract.",
            "retrofit_contract_missing_after_normalization",
            {
              metrics,
              hasStructuredOutput: true,
              rawOutput: output,
              structuredOutput,
              outputPreview: outputPreview(output),
              retrofitPlanNormalization: retrofitNormalized.report,
            },
          );
        }
        return {
          plan: parseOneShotPlan(retrofitNormalized.value),
          sanitizationReport: sanitized.report,
          retrofitPlanNormalization: retrofitNormalized.report,
        };
      } catch (error) {
        initialSchemaValidationErrors = schemaValidationIssuesFromError(
          error,
          "initial_parse",
        );
        logger.warn(
          {
            jiraKey: request.jiraKey,
            error: error instanceof Error ? error.message : String(error),
          },
          "Planner structured output failed validation; attempting deterministic repair",
        );
      }

      const sanitized = sanitizePlannerDiscoveries(structuredOutput);
      const repaired = repairOneShotStructuredPlanOutput(sanitized.value);
      try {
        const retrofitNormalized = normalizeRetrofitPlanFromQualification({
          value: repaired.value,
          retrofitSourceEvidence: request.retrofitSourceEvidence,
          requireRetrofitContract: Boolean(
            request.retrofitContext || request.retrofitSourceEvidence,
          ),
          normalizationReport: {
            ...emptyRetrofitPlanNormalizationReport(),
            normalizedOptionalFields:
              sanitized.report.normalizedOptionalFields,
          },
        });
        if (retrofitNormalized.report.missingAfterNormalization) {
          throw new PlannerStallError(
            "retrofit_contract_missing_after_normalization: Retrofit planner output did not include or seed plannerDiscoveries.retrofitEvidence or plannerDiscoveries.retrofitExecutionContract.",
            "retrofit_contract_missing_after_normalization",
            {
              metrics,
              hasStructuredOutput: true,
              rawOutput: output,
              structuredOutput,
              outputPreview: outputPreview(output),
              structuredOutputRepair: repaired.report,
              retrofitPlanNormalization: retrofitNormalized.report,
            },
          );
        }
        return {
          plan: parseOneShotPlan(retrofitNormalized.value),
          sanitizationReport: sanitized.report,
          structuredOutputRepair: repaired.report,
          retrofitPlanNormalization: retrofitNormalized.report,
        };
      } catch (repairError) {
        const repairSchemaValidationErrors = schemaValidationIssuesFromError(
          repairError,
          "repair_parse",
        );
        if (
          repairError instanceof PlannerStallError &&
          repairError.failureKind === "retrofit_contract_missing_after_normalization"
        ) {
          throw new PlannerStallError(
            repairError.message,
            repairError.failureKind,
            {
              ...repairError.details,
              structuredOutputRepair:
                repairError.details.structuredOutputRepair ?? repaired.report,
              schemaValidationErrors: [
                ...initialSchemaValidationErrors,
                ...repairSchemaValidationErrors,
              ],
              schemaValidationStage: "repair_parse",
            },
          );
        }
        const alreadyAppliedEvidence =
          parseRetrofitAlreadyAppliedEvidence(repaired.value) ??
          parseRetrofitAlreadyAppliedEvidence(sanitized.value);
        if (alreadyAppliedEvidence) {
          throw new PlannerRetrofitAlreadyAppliedError(alreadyAppliedEvidence);
        }

        logger.warn(
          {
            jiraKey: request.jiraKey,
            repairReport: repaired.report,
            error:
              repairError instanceof Error
                ? repairError.message
                : String(repairError),
          },
          "Planner structured output repair failed; not falling back to raw prose",
        );
        throw new PlannerStallError(
          "Planner structured output failed schema validation after SDK success",
          "schema_invalid_after_success",
          {
            metrics,
            hasStructuredOutput: true,
            rawOutput: output,
            structuredOutput,
            outputPreview: outputPreview(output),
            structuredOutputRepair: repaired.report,
            retrofitPlanNormalization:
              repairError instanceof PlannerStallError
                ? repairError.details.retrofitPlanNormalization
                : undefined,
            schemaValidationErrors: [
              ...initialSchemaValidationErrors,
              ...repairSchemaValidationErrors,
            ],
            schemaValidationStage: "repair_parse",
          },
        );
      }
    }

    return this.parsePlanFromOutput(output, request);
  }

  private parsePlanFromOutput(output: string, request?: PlannerRequest): {
    plan: OneShotPlan;
    sanitizationReport: PlannerDiscoverySanitizationReport;
    retrofitPlanNormalization?: RetrofitPlanNormalizationReport;
  } {
    let sanitizationReport: PlannerDiscoverySanitizationReport | undefined;
    let retrofitPlanNormalization: RetrofitPlanNormalizationReport | undefined;
    const { value } = parseValidatedJsonFromTextWithRepair(
      output,
      (candidate) => {
        const sanitized = sanitizePlannerDiscoveries(candidate);
        const retrofitNormalized = normalizeRetrofitPlanFromQualification({
          value: sanitized.value,
          retrofitSourceEvidence: request?.retrofitSourceEvidence,
          requireRetrofitContract: Boolean(
            request?.retrofitContext || request?.retrofitSourceEvidence,
          ),
          normalizationReport: {
            ...emptyRetrofitPlanNormalizationReport(),
            normalizedOptionalFields:
              sanitized.report.normalizedOptionalFields,
          },
        });
        sanitizationReport = sanitized.report;
        retrofitPlanNormalization = retrofitNormalized.report;
        return parseOneShotPlan(retrofitNormalized.value);
      },
    );
    return {
      plan: value,
      sanitizationReport: sanitizationReport ?? {
        truncatedFields: [],
        droppedArrayEntries: 0,
        droppedEmptyValues: 0,
        normalizedOptionalFields: [],
      },
      retrofitPlanNormalization,
    };
  }
}
