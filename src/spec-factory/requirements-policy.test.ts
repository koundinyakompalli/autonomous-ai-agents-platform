import { describe, expect, it } from "vitest";
import {
  clarificationType,
  hasExplicitResearchConsent,
  isUserFacingClarification,
} from "./requirements-policy.js";

describe("requirements policy", () => {
  it.each([
    "Should we reuse the existing submitIre() method?",
    "Which repository should own this service?",
    "Which service owns this workflow?",
    "Should this use a queue or a synchronous endpoint?",
  ])("keeps implementation decisions away from product users: %s", (text) => {
    expect(clarificationType(text)).toBe("implementation");
    expect(isUserFacingClarification(text)).toBe(false);
  });

  it.each([
    "Which user roles may approve the request?",
    "Should cancelled requests remain visible to members?",
    "Which regions are in scope for launch?",
    "Which payment method should members use?",
    "Which customer service teams need access?",
    "Which notification channel should users use?",
  ])("keeps business and functional questions user-facing: %s", (text) => {
    expect(isUserFacingClarification(text)).toBe(true);
  });

  it("honors an explicit category before heuristic classification", () => {
    expect(
      clarificationType({
        text: "Which customer service team owns this outcome?",
        questionType: "functional",
      }),
    ).toBe("functional");
  });

  it("rejects technical text even when an LLM labels it functional", () => {
    expect(
      isUserFacingClarification({
        question: "Should we reuse the existing submitIre() method?",
        questionType: "functional",
      }),
    ).toBe(false);
  });

  it("requires affirmative, non-negated code-research consent", () => {
    expect(
      hasExplicitResearchConsent(
        "Yes, please ask the developer to research the codebase.",
      ),
    ).toBe(true);
    expect(hasExplicitResearchConsent("Do not research the code yet.")).toBe(
      false,
    );
    expect(hasExplicitResearchConsent("What does the user need?")).toBe(false);
  });
});
