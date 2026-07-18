import { describe, expect, it } from "vitest";
import {
  formatProfiledRepoSummariesForPrompt,
  type QualifierProfiledRepoSummary,
} from "./qualifier-repo-context.js";

describe("formatProfiledRepoSummariesForPrompt", () => {
  it("returns a placeholder when no profiled repos are available", () => {
    expect(formatProfiledRepoSummariesForPrompt([])).toBe(
      "(no profiled repositories available)",
    );
  });

  it("renders one block per profiled repo with summary and metadata", () => {
    const summaries: QualifierProfiledRepoSummary[] = [
      {
        repoId: 1,
        repoName: "core-app",
        summary: "Monolith for member, claims, and authorization workflows.",
        aliases: ["core", "monorepo"],
        domains: ["claims", "auth"],
        packages: ["com.medhok.core"],
      },
      {
        repoId: 2,
        repoName: "react-ui",
        summary: "",
        aliases: [],
        domains: [],
        packages: [],
      },
    ];
    const formatted = formatProfiledRepoSummariesForPrompt(summaries);
    expect(formatted).toContain("### core-app (id=1)");
    expect(formatted).toContain("Summary: Monolith for member");
    expect(formatted).toContain("Aliases: core, monorepo");
    expect(formatted).toContain("Domains: claims, auth");
    expect(formatted).toContain("Packages: com.medhok.core");
    expect(formatted).toContain("### react-ui (id=2)");
    expect(formatted).toContain("Summary: (no curated summary available)");
  });

  it("truncates long package lists to keep the prompt bounded", () => {
    const packages = Array.from({ length: 40 }, (_, i) => `pkg-${i}`);
    const formatted = formatProfiledRepoSummariesForPrompt([
      {
        repoId: 1,
        repoName: "noisy-repo",
        summary: "many packages",
        aliases: [],
        domains: [],
        packages,
      },
    ]);
    expect(formatted).toContain("pkg-0");
    expect(formatted).toContain("pkg-24");
    expect(formatted).not.toContain("pkg-25");
  });
});
