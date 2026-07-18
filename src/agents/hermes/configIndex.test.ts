import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { buildHermesConfigIndex } from "./configIndex.js";

const tempRoots: string[] = [];

async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hermes-config-"));
  tempRoots.push(root);
  await mkdir(join(root, "config"), { recursive: true });
  await mkdir(join(root, "core-app", "src", "main", "java"), {
    recursive: true,
  });
  await writeFile(
    join(root, "config", "system_variables.md"),
    [
      "# System Variables",
      "",
      "CLAIM_AUTO_CLOSE_ENABLED controls whether claims are auto closed.",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(root, "core-app", "src", "main", "java", "ClaimConfigService.java"),
    'class ClaimConfigService { String code = "CLAIM_AUTO_CLOSE_ENABLED"; }\n',
  );
  return root;
}

describe("buildHermesConfigIndex", () => {
  afterEach(async () => {
    await Promise.all(
      tempRoots
        .splice(0)
        .map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("prioritizes config documentation and includes code usage hits", async () => {
    const workspace = await makeWorkspace();

    const index = await buildHermesConfigIndex({
      repositoryPath: workspace,
      query: "What does CLAIM_AUTO_CLOSE_ENABLED do?",
    });

    expect(index).toContain("## HERMES Deterministic Config Index");
    expect(index).toContain("config/system_variables.md");
    expect(index).toContain("ClaimConfigService.java");
    expect(index).toContain("Source precedence");
  });

  it("includes a bounded config file inventory even when terms miss", async () => {
    const workspace = await makeWorkspace();

    const index = await buildHermesConfigIndex({
      repositoryPath: workspace,
      query: "Where is UNKNOWN_RUNTIME_TOGGLE configured?",
    });

    expect(index).toContain("### Config File Inventory");
    expect(index).toContain("config/system_variables.md");
  });

  it("returns not-found guidance when no repository path is available", async () => {
    const index = await buildHermesConfigIndex({
      query: "Find MISSING_CONFIG",
    });

    expect(index).toContain("Repository config index unavailable");
    expect(index).toContain("resolution_status");
  });
});
