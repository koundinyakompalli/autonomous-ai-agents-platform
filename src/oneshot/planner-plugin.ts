import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

export const ONESHOT_PLANNER_PLUGIN_NAME = "oneshot-planner";
export const DEFAULT_ONESHOT_PLANNER_PLUGIN_PATH =
  "oneshot-prompts/plugins/oneshot-planner";

export const ONESHOT_PLANNER_SKILL_NAMES = [
  "planner-grounding",
  "logical-decomposition",
  "medhok-domain-planning",
  "planner-scouting",
  "plan-quality-gate",
  "test-first-validation-planning",
  "root-cause-investigation-planning",
] as const;

export const ONESHOT_PLANNER_PLUGIN_SKILLS = ONESHOT_PLANNER_SKILL_NAMES.map(
  (skillName) => `${ONESHOT_PLANNER_PLUGIN_NAME}:${skillName}`,
);

function normalizePluginPathForComparison(pluginPath: string): string {
  return pluginPath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

export function resolveBundledOneShotPlannerPluginPath(
  cwd = process.cwd(),
): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDir, "..", "..", DEFAULT_ONESHOT_PLANNER_PLUGIN_PATH),
    path.resolve(cwd, DEFAULT_ONESHOT_PLANNER_PLUGIN_PATH),
  ];

  return (
    candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]
  );
}

export function resolveOneShotPlannerPluginPath(
  pluginPath?: string,
  options: { cwd?: string } = {},
): string {
  const cwd = options.cwd ?? process.cwd();
  const rawPath = pluginPath?.trim();
  if (
    !rawPath ||
    normalizePluginPathForComparison(rawPath) ===
      DEFAULT_ONESHOT_PLANNER_PLUGIN_PATH
  ) {
    return resolveBundledOneShotPlannerPluginPath(cwd);
  }
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath);
}
