import { describe, expect, it } from "vitest";
import { previewNaturalLanguageIntent } from "./watchdog.js";

describe("previewNaturalLanguageIntent", () => {
  it("prefills Medhok QAM1 startup failure prompts", () => {
    const preview = previewNaturalLanguageIntent("check Medhok QAM1 startup failures", ["MEDHOK"], [
      "QAM1",
      "RUD1",
    ]);

    expect(preview.suggestedScope.clientId).toBe("MEDHOK");
    expect(preview.suggestedScope.environment).toBe("QAM1");
    expect(preview.suggestedScope.serviceIds).toEqual(["core"]);
    expect(preview.suggestedScope.includeKeywords).toEqual(expect.arrayContaining(["startup", "fail"]));
    expect(preview.ambiguities).toEqual([]);
    expect(preview.suggestions.confidence).toBeGreaterThan(0.7);
  });

  it("uses catalog environments to resolve unique shorthand environment names", () => {
    const preview = previewNaturalLanguageIntent(
      "check if Medhok RUD has an errors in the last hour",
      ["MEDHOK"],
      ["MA1", "MEDHOK1", "QAM1", "RUD1"],
    );

    expect(preview.suggestedScope.clientId).toBe("MEDHOK");
    expect(preview.suggestedScope.environment).toBe("RUD1");
    expect(preview.suggestedScope.timeWindow.sourceHint).toBe("last 1 hours");
    expect(preview.suggestions.environmentCandidates).toEqual(["RUD1"]);
    expect(preview.ambiguities).toEqual([]);
  });

  it("prefills operational health keywords instead of defaulting OpenSearch checks to error", () => {
    const preview = previewNaturalLanguageIntent(
      "check if Opensearch is running in Medhok RUD1 core-app",
      ["MEDHOK"],
      ["QAM1", "RUD1"],
    );

    expect(preview.suggestedScope.clientId).toBe("MEDHOK");
    expect(preview.suggestedScope.environment).toBe("RUD1");
    expect(preview.suggestedScope.serviceIds).toEqual(["core"]);
    expect(preview.suggestedScope.includeKeywords).toEqual(
      expect.arrayContaining(["opensearch", "running"]),
    );
    expect(preview.suggestedScope.includeKeywords).not.toContain("error");
    expect(preview.ambiguities).toEqual([]);
  });

  it("does not guess ambiguous shorthand environment names", () => {
    const preview = previewNaturalLanguageIntent("check Medhok QA errors", ["MEDHOK"], [
      "QA1",
      "QA2",
      "QA3",
    ]);

    expect(preview.suggestedScope.environment).toBe("");
    expect(preview.suggestions.environmentCandidates).toEqual(["QA1", "QA2", "QA3"]);
    expect(preview.ambiguities).toContain("environment");
  });

  it("keeps the existing CIGNA auth error path working", () => {
    const preview = previewNaturalLanguageIntent(
      "Investigate CIGNA PROD core app auth errors from the last 3 hours",
      ["CIGNA"],
    );

    expect(preview.suggestedScope.clientId).toBe("CIGNA");
    expect(preview.suggestedScope.environment).toBe("PROD");
    expect(preview.suggestedScope.serviceIds).toEqual(["core"]);
    expect(preview.suggestedScope.includeKeywords).toEqual(expect.arrayContaining(["auth", "error"]));
  });

  it("matches arbitrary catalog clients without code changes", () => {
    const preview = previewNaturalLanguageIntent("check ALLYMAR PROD1 startup failures", [
      "AETNA",
      "ALLYMAR",
      "CIGNA",
    ]);

    expect(preview.suggestedScope.clientId).toBe("ALLYMAR");
    expect(preview.suggestedScope.environment).toBe("PROD1");
    expect(preview.suggestions.clientCandidates).toEqual(["ALLYMAR"]);
    expect(preview.ambiguities).toEqual([]);
  });
});
