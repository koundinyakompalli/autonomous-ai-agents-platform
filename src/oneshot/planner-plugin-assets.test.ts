import * as fs from "fs/promises";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { CORE_GUARDRAIL_IDS } from "./schema/plan.js";
import {
  DEFAULT_ONESHOT_PLANNER_PLUGIN_PATH,
  resolveOneShotPlannerPluginPath,
} from "./planner-plugin.js";

const PLUGIN_ROOT = path.resolve(
  process.cwd(),
  "oneshot-prompts/plugins/oneshot-planner",
);

const PLANNER_SKILLS = [
  "planner-grounding",
  "logical-decomposition",
  "medhok-domain-planning",
  "planner-scouting",
  "plan-quality-gate",
  "test-first-validation-planning",
  "root-cause-investigation-planning",
] as const;

async function readText(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf8");
}

describe("OneShot planner plugin assets", () => {
  it("resolves the bundled planner plugin from the package root before cwd", async () => {
    const unrelatedCwd = path.join(process.cwd(), "tmp-does-not-own-plugin");

    expect(
      resolveOneShotPlannerPluginPath(DEFAULT_ONESHOT_PLANNER_PLUGIN_PATH, {
        cwd: unrelatedCwd,
      }),
    ).toBe(PLUGIN_ROOT);
    expect(
      resolveOneShotPlannerPluginPath(undefined, {
        cwd: unrelatedCwd,
      }),
    ).toBe(PLUGIN_ROOT);
  });

  it("declares a local Claude plugin with the expected name", async () => {
    const manifestPath = path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json");
    const manifest = JSON.parse(await readText(manifestPath)) as {
      name?: string;
      version?: string;
      description?: string;
      skills?: string;
    };

    expect(manifest.name).toBe("oneshot-planner");
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.description).toContain("OneShot planner");
    expect(manifest.skills).toBe("./skills");
  });

  it("ships all planner Skills with valid frontmatter and no placeholders", async () => {
    for (const skillName of PLANNER_SKILLS) {
      const skillPath = path.join(PLUGIN_ROOT, "skills", skillName, "SKILL.md");
      const content = await readText(skillPath);

      expect(content).toMatch(/^---\n/);
      expect(content).toMatch(new RegExp(`\\nname:\\s*${skillName}\\n`));
      expect(content).toMatch(/\ndescription:\s*\S/);
      expect(content).not.toMatch(/\b(?:TODO|TBD|PLACEHOLDER)\b/i);
    }
  });

  it("keeps planner Skills aligned to one non-blocking structured plan", async () => {
    const logicalDecomposition = await readText(
      path.join(PLUGIN_ROOT, "skills", "logical-decomposition", "SKILL.md"),
    );
    expect(logicalDecomposition).toContain("one final OneShot plan JSON");
    expect(logicalDecomposition).toContain("not standalone tasks");

    const plannerScouting = await readText(
      path.join(PLUGIN_ROOT, "skills", "planner-scouting", "SKILL.md"),
    );
    expect(plannerScouting).toContain("still produce the structured plan");

    const planQualityGate = await readText(
      path.join(PLUGIN_ROOT, "skills", "plan-quality-gate", "SKILL.md"),
    );
    expect(planQualityGate).toContain(
      "The structured OneShot plan JSON is mandatory",
    );
    expect(planQualityGate).toContain("testingStrategy");
    expect(planQualityGate).toContain(
      "fileChangeContract` as the canonical edit-scope",
    );
    expect(planQualityGate).toContain(
      "targetFileRationales` only as optional compatibility detail",
    );

    const testFirstValidationPlanning = await readText(
      path.join(
        PLUGIN_ROOT,
        "skills",
        "test-first-validation-planning",
        "SKILL.md",
      ),
    );
    expect(testFirstValidationPlanning).toContain(
      "testingStrategy.plannedAutomatedTests",
    );
    expect(testFirstValidationPlanning).toContain("test_required");
  });

  it("documents every required core guardrail id in planner guidance", async () => {
    const planSystemPrompt = await readText(
      path.resolve(process.cwd(), "oneshot-prompts/prompts/plan-system.md"),
    );
    const planQualityGate = await readText(
      path.join(PLUGIN_ROOT, "skills", "plan-quality-gate", "SKILL.md"),
    );

    for (const guardrailId of CORE_GUARDRAIL_IDS) {
      expect(planSystemPrompt).toContain(guardrailId);
      expect(planQualityGate).toContain(guardrailId);
    }
    expect(planSystemPrompt).toContain(
      "`fileChangeContract` is the canonical edit-scope",
    );
    expect(planSystemPrompt).toContain(
      "`targetFileRationales[]` is optional compatibility detail",
    );
    expect(planSystemPrompt).not.toContain(
      "New adjacent files must be justified by `targetFileRationales[]`",
    );
  });
});
