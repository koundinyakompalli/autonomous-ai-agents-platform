import { describe, expect, it } from "vitest";
import { deriveComposeSourceIntelligence } from "./compose-source-intelligence.js";

describe("deriveComposeSourceIntelligence", () => {
  it("summarizes source text, extracts entities, and scores high-signal evidence", () => {
    const intelligence = deriveComposeSourceIntelligence({
      kind: "jira",
      filename: "CPDEV-123 Medical Appeals",
      markdown:
        "# CPDEV-123 Medical Appeals Case Creation\n" +
        "Client: BCBSRI\n" +
        "Repo: core-app\n" +
        "File: AppealsController.java\n" +
        "LOE: 24 hours\n" +
        "Due: 2026-06-30\n" +
        "Acceptance Criteria:\n" +
        "- Create appeals cases from intake data.\n" +
        "Assumption: Queue already exists.",
    });

    expect(intelligence.summary).toBe(
      "CPDEV-123 Medical Appeals Case Creation",
    );
    expect(intelligence.usefulness).toBe("high_signal");
    expect(intelligence.entities).toMatchObject({
      jiraKeys: ["CPDEV-123"],
      repositories: ["core-app"],
      files: ["AppealsController.java"],
      clients: ["BCBSRI"],
      loeHours: [24],
      dates: ["2026-06-30"],
      assumptions: ["Queue already exists"],
    });
    expect(intelligence.contribution).toContain("High-signal");
  });

  it("marks short source text without repository evidence as weak requirement detail", () => {
    const intelligence = deriveComposeSourceIntelligence({
      kind: "note",
      filename: "note.md",
      markdown: "Need to fix this soon.",
    });

    expect(intelligence.usefulness).toBe("weak_requirement_detail");
    expect(intelligence.entities.repositories).toEqual([]);
  });

  it("extracts field entities from punctuation-heavy source text without preserving long separators", () => {
    const intelligence = deriveComposeSourceIntelligence({
      kind: "note",
      filename: "security-note.md",
      markdown:
        `Repo: provider-portal${"\t".repeat(5000)},,,,,\n` +
        `Client: BCBSRI${",".repeat(5000)}\n` +
        "Estimate: 12 hrs\n" +
        `Assumptions: Queue already exists${"\t".repeat(5000)},,,,,`,
    });

    expect(intelligence.entities.repositories).toContain("provider-portal");
    expect(intelligence.entities.clients).toEqual(["BCBSRI"]);
    expect(intelligence.entities.loeHours).toEqual([12]);
    expect(intelligence.entities.assumptions).toEqual(["Queue already exists"]);
  });
});
