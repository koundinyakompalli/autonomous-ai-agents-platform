import { describe, expect, it } from "vitest";
import {
  isCompleteGherkinScenario,
  normalizeGherkinCriteria,
  normalizeGherkinCriterion,
} from "./gherkin.js";

describe("Gherkin normalization", () => {
  it("preserves complete scenarios", () => {
    const scenario = [
      "Scenario: Export invoices",
      "Given an authorized billing user",
      "When the user exports the current period",
      "Then a CSV file is downloaded",
    ].join("\n");

    expect(normalizeGherkinCriterion(scenario, "Export invoices", 0)).toBe(
      scenario,
    );
    expect(isCompleteGherkinScenario(scenario)).toBe(true);
  });

  it("expands a one-line outcome into a complete scenario", () => {
    expect(normalizeGherkinCriterion("CSV is downloaded", "Export", 0)).toBe(
      [
        "Scenario: Export - outcome 1",
        "Given the stated business prerequisites are satisfied",
        "When the user completes the described workflow",
        "Then CSV is downloaded",
      ].join("\n"),
    );
  });

  it("creates a scenario when a story has no criteria", () => {
    const [scenario] = normalizeGherkinCriteria(
      [],
      "Review request",
      "The request can be reviewed",
    );
    expect(isCompleteGherkinScenario(scenario ?? "")).toBe(true);
  });
});
