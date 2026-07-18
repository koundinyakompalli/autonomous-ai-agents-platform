import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const governancePaths = [
  "meridian/backend",
  "src/investigation",
  "src/orchestrator/workers/MERIDIANWorker.ts",
  "dashboard/server/services",
  "dashboard/server/routes",
  "db/migrations",
  "AI_GOVERNANCE_COMPLIANCE.md",
  "docs/01-GETTING-STARTED.md",
  "docs/MERIDIAN_INVESTIGATION_COCKPIT_ARCHITECTURE.md",
  ".github/workflows/governance-controls.yml",
  ".github/workflows/governance-promotion-check.yml",
  "scripts/governance-diff.mjs",
];

const forbiddenTokens = [
  "raw_query_enabled",
  "MERIDIAN_ENABLE_RAW_QUERY",
  "validate_bounded_select",
  '@router.post("/query")',
  "allowRawSqlJiraAttachment",
  "MERIDIAN_ALLOW_RAW_SQL_JIRA_ATTACHMENT",
  "investigationHistory",
  "INVESTIGATION_RUN_HISTORY",
  "051_investigation_cockpit_history",
  "investigation_runs",
  "investigation_events",
  "rejectUnauthorized: false",
];

function listFiles(entry: string): string[] {
  const absolute = path.join(root, entry);
  if (!existsSync(absolute)) {
    return [];
  }
  const stat = statSync(absolute);
  if (stat.isFile()) {
    return [absolute];
  }
  return readdirSync(absolute).flatMap((name) => {
    const child = path.join(absolute, name);
    if (statSync(child).isDirectory()) {
      return listFiles(path.relative(root, child));
    }
    return [child];
  });
}

function readRepoFile(entry: string): string {
  return readFileSync(path.join(root, entry), "utf8");
}

describe("MERIDIAN/Cockpit governance control locks", () => {
  it("keeps prohibited local-only capabilities absent from PHI-touching paths", () => {
    const hits: string[] = [];
    for (const file of governancePaths.flatMap(listFiles)) {
      const text = readFileSync(file, "utf8");
      for (const token of forbiddenTokens) {
        if (text.includes(token)) {
          hits.push(`${path.relative(root, file)} contains ${token}`);
        }
      }
    }

    expect(hits).toEqual([]);
  });

  it("keeps secure local-only defaults active", () => {
    const meridianSecurity = readRepoFile("meridian/backend/security.py");
    const meridianWorker = readRepoFile("src/orchestrator/workers/MERIDIANWorker.ts");
    const investigationRuntime = readRepoFile("dashboard/server/services/investigationRuntime.ts");

    expect(meridianSecurity).toMatch(/def auth_required\(\).*?return packaged_mode\(\) or _env_flag\("MERIDIAN_REQUIRE_BACKEND_AUTH", True\)/s);
    expect(meridianSecurity).toMatch(/def profile_store_enabled\(\).*?return False/s);
    expect(meridianWorker).toMatch(/return envFlag\("MERIDIAN_REQUIRE_OPERATOR_DB_CREDENTIALS", true\)/);
    expect(meridianWorker).toMatch(/return envFlag\("MERIDIAN_ALLOW_HOSTED_ACCESS", false\)/);
    expect(investigationRuntime).toMatch(/return envFlag\("INVESTIGATION_REQUIRE_OPERATOR_DB_CREDENTIALS", true\)/);
    expect(investigationRuntime).toMatch(/return envFlag\("INVESTIGATION_ALLOW_TARGET_SECRET_DB_CREDENTIALS", false\)/);
    expect(readRepoFile("src/investigation/adapters/DataDiagnosticsAdapter.ts")).toMatch(/return envFlag\('INVESTIGATION_REQUIRE_OPERATOR_DB_CREDENTIALS', true\)/);
    expect(readRepoFile("src/investigation/adapters/DataDiagnosticsAdapter.ts")).toMatch(/return envFlag\('INVESTIGATION_ALLOW_TARGET_SECRET_DB_CREDENTIALS', false\)/);
  });

  it("keeps change-control artifacts bound to governance-scoped paths", () => {
    const controlsWorkflow = readRepoFile(".github/workflows/governance-controls.yml");
    const promotionWorkflow = readRepoFile(".github/workflows/governance-promotion-check.yml");
    const governanceDiff = readRepoFile("scripts/governance-diff.mjs");

    for (const diffPath of [
      "meridian/backend",
      "src/investigation",
      "src/orchestrator/workers/MERIDIANWorker.ts",
      "dashboard/server/services",
      "dashboard/server/routes",
      "db/migrations",
    ]) {
      expect(governanceDiff).toContain(diffPath);
    }

    expect(existsSync(path.join(root, ".github/CODEOWNERS"))).toBe(false);
    expect(controlsWorkflow).not.toMatch(/branches:\s*\n\s+- main/);
    expect(controlsWorkflow).toContain('"release-*"');
    expect(controlsWorkflow).toContain('"release/**"');
    expect(promotionWorkflow).toContain("actions/create-github-app-token@v3");
    expect(promotionWorkflow).toContain("app-id: ${{ secrets.APP_ID }}");
    expect(promotionWorkflow).toContain("private-key: ${{ secrets.APP_PRIVATE_KEY }}");
    expect(promotionWorkflow).toContain("Inspect required governance reviews");
    expect(promotionWorkflow).toContain("steps.governance-review-state.outputs.missing_count != '0'");
    expect(promotionWorkflow).toContain("GH_TOKEN: ${{ steps.governance-review-token.outputs.token }}");
    expect(promotionWorkflow).toContain("team_reviewers[]=cp-compliance");
    expect(promotionWorkflow).toContain("team_reviewers[]=cp-security");
    expect(promotionWorkflow).toContain("Verify required governance reviews");
    expect(promotionWorkflow).toContain("Required governance review team is missing");
    expect(promotionWorkflow).toContain('"release-*"');
    expect(promotionWorkflow).toContain('"release/**"');
    expect(promotionWorkflow).toContain("scripts/governance-diff.mjs");
    expect(readRepoFile("package.json")).toContain("\"governance:diff\"");
  });

  it("uses the candidate parent when a release branch creation has an all-zero before SHA", () => {
    const repository = mkdtempSync(path.join(tmpdir(), "governance-diff-test-"));
    const git = (args: string[]) => spawnSync("git", args, { cwd: repository, encoding: "utf8" });
    try {
      expect(git(["init"]).status).toBe(0);
      expect(git(["config", "user.name", "Governance Test"]).status).toBe(0);
      expect(git(["config", "user.email", "governance@example.test"]).status).toBe(0);
      writeFileSync(path.join(repository, "baseline.txt"), "baseline\n");
      expect(git(["add", "baseline.txt"]).status).toBe(0);
      expect(git(["commit", "-m", "baseline"]).status).toBe(0);
      writeFileSync(path.join(repository, "candidate.txt"), "candidate\n");
      expect(git(["add", "candidate.txt"]).status).toBe(0);
      expect(git(["commit", "-m", "candidate"]).status).toBe(0);

      const result = spawnSync(
        process.execPath,
        [path.join(root, "scripts/governance-diff.mjs"), "0".repeat(40), "HEAD"],
        { cwd: repository, encoding: "utf8" },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Branch creation detected; comparing candidate with first parent");
      expect(result.stderr).not.toContain("Needed a single revision");
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });
});
