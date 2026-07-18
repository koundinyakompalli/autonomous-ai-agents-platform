import { describe, expect, it } from "vitest";
import {
  formatScanForPrompt,
  getRepoMentionTokens,
  getRepositorySlug,
  buildRepoRouteCardContext,
  getRepoRouteCardMatches,
  type RepoScanResult,
} from "./index.js";

function scan(overrides: Partial<RepoScanResult> = {}): RepoScanResult {
  return {
    scannedAt: "2026-06-17T00:00:00.000Z",
    workspacePath: "/w/core-app",
    techStack: {
      primaryLanguage: "TypeScript",
      buildTool: "npm",
      testFramework: "vitest",
      frameworks: ["express"],
    },
    projectStructure: {
      rootFiles: ["package.json"],
      topLevelDirs: ["src"],
      estimatedFileCount: 120,
      extensionBreakdown: { ".ts": 100 },
    },
    keyFiles: [
      { path: "src/index.ts", role: "entry_point", description: "entry" },
    ],
    projectGuidanceFiles: [],
    ...overrides,
  };
}

describe("repo-intel barrel", () => {
  it("re-exports formatScanForPrompt which renders the pre-scanned intelligence block", () => {
    const out = formatScanForPrompt(scan());
    expect(out).toContain("Codebase Intelligence (pre-scanned)");
    expect(out).toContain("TypeScript");
    expect(out).toContain("src/index.ts");
  });

  it("re-exports repo-identify helpers", () => {
    expect(getRepositorySlug("https://github.com/org/core-app.git")).toBe(
      "core-app",
    );
    const tokens = getRepoMentionTokens({
      repo_name: "core-app",
      repo_url: "https://github.com/org/core-app.git",
    });
    expect(tokens).toContain("core-app");
  });

  it("re-exports route-card helpers as callable functions", () => {
    expect(typeof buildRepoRouteCardContext).toBe("function");
    expect(typeof getRepoRouteCardMatches).toBe("function");
  });
});
